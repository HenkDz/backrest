import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders as render } from "../../test/render";
import {
  DatabaseRestore,
  recoveryAction,
  type RecoveryJob,
} from "./DatabaseRestore";
const fetchRecovery = vi.hoisted(() => vi.fn());
vi.mock("../../api/client", () => ({ authenticatedFetch: fetchRecovery }));
const snapshotId = "a".repeat(64);
const jobId = "b".repeat(32);
const baseJob: RecoveryJob = { id: jobId, snapshotId, phase: "frozen" };
const snapshot = { id: snapshotId, time: "2026-10-14T01:00:00Z" };
const posts = () =>
  fetchRecovery.mock.calls.filter((call) => call[1]?.method === "POST");
const status = (job: RecoveryJob | null) => ({
  environment: "staging",
  target: "dzdistro-staging",
  repoId: "dzdistro-staging-postgres",
  job,
});
const page = {
  snapshots: [snapshot],
  total: 1,
  available: 1,
  page: 1,
  pageSize: 25,
  pages: 1,
  latestId: snapshotId,
};
function mockEndpoints(job: RecoveryJob | null = null) {
  fetchRecovery.mockImplementation(async (url, options) => ({
    ok: true,
    json: async () =>
      String(url).includes("view=snapshots")
        ? page
        : status(
            options?.method === "POST"
              ? { ...baseJob, phase: "validated" }
              : job,
          ),
  }));
}
describe("guided staging recovery", () => {
  beforeEach(() => {
    fetchRecovery.mockReset();
    mockEndpoints();
  });
  it("offers no automatic action for uncertain or interrupted switches", () => {
    for (const phase of [
      "held",
      "switching",
      "freezing",
      "preparing",
      "resuming",
    ])
      expect(recoveryAction({ ...baseJob, phase })).toBeNull();
    expect(recoveryAction(baseJob)?.phrase).toBe(
      "RESTORE DZDISTRO STAGING aaaaaaaa",
    );
    expect(
      recoveryAction({ ...baseJob, phase: "resumed", rolledBack: true }),
    ).toBeNull();
  });
  it("requires a chosen snapshot and sends no client target or actor", async () => {
    render(<DatabaseRestore />);
    await screen.findByRole("radio", { name: /aaaaaaaa/ });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Refresh recovery status/ }),
      ).toBeEnabled(),
    );
    expect(screen.getByRole("button", { name: /Test restore/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /aaaaaaaa/ }));
    fireEvent.click(screen.getByRole("button", { name: /Test restore/ }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(posts()[0][1].body)).toEqual({
      action: "prepare",
      snapshotId,
    });
  });
  it("retains a failed selection and reason independent of the visible page", async () => {
    mockEndpoints({
      ...baseJob,
      phase: "failed",
      snapshotTime: snapshot.time,
      failureReason: "Schema did not match.",
    });
    render(<DatabaseRestore />);
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Schema did not match.",
    );
    expect(screen.getByRole("button", { name: /Test restore/ })).toBeEnabled();
    expect(screen.getByLabelText("Selected recovery point")).toHaveTextContent(
      snapshotId,
    );
  });
  it("refreshes failed test status without retrying the mutation", async () => {
    let failed = false;
    fetchRecovery.mockImplementation(async (url, options) => {
      if (String(url).includes("view=snapshots"))
        return { ok: true, json: async () => page };
      if (options?.method === "POST") {
        failed = true;
        return {
          ok: false,
          json: async () => ({ error: "Schema did not match." }),
        };
      }
      return {
        ok: true,
        json: async () =>
          status(
            failed
              ? {
                  ...baseJob,
                  phase: "failed",
                  failureReason: "Schema did not match.",
                  validation: {
                    tables: 123,
                    rows: 71645,
                    schemaHash: "different",
                  },
                }
              : null,
          ),
      };
    });
    render(<DatabaseRestore />);
    await screen.findByRole("radio", { name: /aaaaaaaa/ });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Refresh recovery status/ }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("radio", { name: /aaaaaaaa/ }));
    fireEvent.click(screen.getByRole("button", { name: /Test restore/ }));
    await screen.findByRole("heading", { name: "Recovery status: failed" });
    expect(screen.getByRole("radio", { name: /aaaaaaaa/ })).toBeChecked();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText(/123 tables.*rows inspected/)).toBeInTheDocument();
    expect(
      screen.queryByText(/schema compatibility passed/),
    ).not.toBeInTheDocument();
    expect(posts()).toHaveLength(1);
    expect(
      fetchRecovery.mock.calls.filter(
        (call) =>
          !String(call[0]).includes("view=snapshots") && !call[1]?.method,
      ),
    ).toHaveLength(2);
  });
  it("will not switch with an empty or wrong confirmation", async () => {
    mockEndpoints(baseJob);
    render(<DatabaseRestore />);
    const button = await screen.findByRole("button", {
      name: "Restore staging database",
    });
    expect(button).toBeDisabled();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Recovery confirmation" }),
      { target: { value: "RESTORE PRODUCTION" } },
    );
    expect(button).toBeDisabled();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Recovery confirmation" }),
      { target: { value: "RESTORE DZDISTRO STAGING aaaaaaaa" } },
    );
    expect(button).toBeEnabled();
  });
  it.each(["restored", "resume-committed"])(
    "requires reconciliation before resuming %s",
    async (phase) => {
      mockEndpoints({ ...baseJob, phase });
      render(<DatabaseRestore />);
      const button = await screen.findByRole("button", {
        name:
          phase === "resume-committed"
            ? "Finish resume cleanup"
            : "Resume staging",
      });
      fireEvent.change(
        screen.getByRole("textbox", { name: "Recovery confirmation" }),
        { target: { value: "RESUME DZDISTRO STAGING bbbbbbbb" } },
      );
      expect(button).toBeDisabled();
      fireEvent.click(screen.getByRole("checkbox"));
      expect(button).toBeEnabled();
      fireEvent.click(button);
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(JSON.parse(posts()[0][1].body)).toEqual({
        action: "resume",
        jobId,
        confirmation: "RESUME DZDISTRO STAGING bbbbbbbb",
        queuesReconciled: true,
      });
    },
  );
});
