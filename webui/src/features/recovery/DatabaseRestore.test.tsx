import { describe, expect, it, vi } from "vitest";
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

describe("guided staging recovery", () => {
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
    fetchRecovery.mockResolvedValue({
      ok: true,
      json: async () => ({
        environment: "staging",
        target: "dzdistro-staging",
        repoId: "dzdistro-staging-postgres",
        snapshots: [{ id: snapshotId, time: "2026-10-14T01:00:00Z" }],
        job: null,
      }),
    });
    render(<DatabaseRestore />);
    await screen.findByRole("radio", { name: /aaaaaaaa/ });
    expect(screen.getByRole("button", { name: /Test restore/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /aaaaaaaa/ }));
    fireEvent.click(screen.getByRole("button", { name: /Test restore/ }));
    await waitFor(() => expect(fetchRecovery).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetchRecovery.mock.calls[1][1].body)).toEqual({
      action: "prepare",
      snapshotId,
    });
  });

  it("shows newest backups first and retains a failed selection after reload", async () => {
    fetchRecovery.mockClear();
    const older = "c".repeat(64);
    fetchRecovery.mockResolvedValue({
      ok: true,
      json: async () => ({
        environment: "staging",
        snapshots: [
          { id: older, time: "2026-10-13T01:00:00Z" },
          { id: snapshotId, time: "2026-10-14T01:00:00Z" },
        ],
        job: {
          ...baseJob,
          phase: "failed",
          failureReason: "Schema did not match.",
        },
      }),
    });
    render(<DatabaseRestore />);
    const radios = await screen.findAllByRole("radio");
    expect(radios[0]).toHaveAccessibleName(/aaaaaaaa/);
    expect(radios[0]).toBeChecked();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Schema did not match.",
    );
    expect(screen.getByRole("button", { name: /Test restore/ })).toBeEnabled();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("refreshes failed test status without retrying the mutation", async () => {
    fetchRecovery.mockClear();
    const state = {
      environment: "staging",
      snapshots: [{ id: snapshotId, time: "2026-10-14T01:00:00Z" }],
      job: null,
    };
    fetchRecovery
      .mockResolvedValueOnce({ ok: true, json: async () => state })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "Schema did not match." }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...state,
          job: {
            ...baseJob,
            phase: "failed",
            failureReason: "Schema did not match.",
          },
        }),
      });
    render(<DatabaseRestore />);
    fireEvent.click(await screen.findByRole("radio", { name: /aaaaaaaa/ }));
    fireEvent.click(screen.getByRole("button", { name: /Test restore/ }));
    await screen.findByRole("heading", { name: "Recovery status: failed" });
    expect(screen.getByRole("radio", { name: /aaaaaaaa/ })).toBeChecked();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(fetchRecovery).toHaveBeenCalledTimes(3);
    expect(fetchRecovery.mock.calls[2][1]).toBeUndefined();
    expect(
      fetchRecovery.mock.calls.filter((call) => call[1]?.method === "POST"),
    ).toHaveLength(1);
  });

  it("will not switch with an empty or wrong confirmation", async () => {
    fetchRecovery.mockClear();
    fetchRecovery.mockResolvedValue({
      ok: true,
      json: async () => ({
        environment: "staging",
        snapshots: [],
        job: baseJob,
      }),
    });
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
      fetchRecovery.mockResolvedValue({
        ok: true,
        json: async () => ({
          environment: "staging",
          snapshots: [],
          job: { ...baseJob, phase },
        }),
      });
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
      await waitFor(() =>
        expect(JSON.parse(fetchRecovery.mock.calls.at(-1)![1].body)).toEqual({
          action: "resume",
          jobId,
          confirmation: "RESUME DZDISTRO STAGING bbbbbbbb",
          queuesReconciled: true,
        }),
      );
    },
  );
});
