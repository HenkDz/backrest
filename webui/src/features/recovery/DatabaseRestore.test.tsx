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
    await screen.findByRole("option", { name: /aaaaaaaa/ });
    expect(screen.getByRole("button", { name: /Test restore/ })).toBeDisabled();
    fireEvent.change(
      screen.getByRole("combobox", { name: "Recovery snapshot" }),
      { target: { value: snapshotId } },
    );
    fireEvent.click(screen.getByRole("button", { name: /Test restore/ }));
    await waitFor(() => expect(fetchRecovery).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetchRecovery.mock.calls[1][1].body)).toEqual({
      action: "prepare",
      snapshotId,
    });
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

  it("holds resume until the operator reconciles queued work and caches", async () => {
    fetchRecovery.mockResolvedValue({
      ok: true,
      json: async () => ({
        environment: "staging",
        snapshots: [],
        job: { ...baseJob, phase: "restored" },
      }),
    });
    render(<DatabaseRestore />);
    const button = await screen.findByRole("button", {
      name: "Resume staging",
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Recovery confirmation" }),
      { target: { value: "RESUME DZDISTRO STAGING bbbbbbbb" } },
    );
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(button).toBeEnabled();
  });
});
