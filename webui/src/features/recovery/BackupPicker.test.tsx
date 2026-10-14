import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders as render } from "../../test/render";
import {
  BackupPicker,
  SelectedRecoveryPoint,
  type RecoverySnapshot,
} from "./BackupPicker";
const fetchBackups = vi.hoisted(() => vi.fn());
vi.mock("../../api/client", () => ({ authenticatedFetch: fetchBackups }));
const a = {
  id: "a".repeat(64),
  time: "2026-10-14T01:00:00Z",
  hostname: "staging",
  tags: ["daily"],
};
const b = { ...a, id: "b".repeat(64), time: "2026-10-13T01:00:00Z" };
const page = (snapshots = [a], number = 1) => ({
  snapshots,
  total: 100000,
  available: 100000,
  page: number,
  pageSize: 25,
  pages: 4000,
  latestId: a.id,
});
const search = () =>
  fireEvent.submit(
    screen.getByRole("textbox", { name: "Search backups" }).closest("form")!,
  );
function Harness() {
  const [selected, setSelected] = useState<RecoverySnapshot | null>(null);
  return (
    <>
      <SelectedRecoveryPoint
        selected={selected}
        onClear={() => setSelected(null)}
        disabled={false}
      />
      <BackupPicker
        selected={selected}
        onSelect={setSelected}
        disabled={false}
      />
    </>
  );
}
describe("large backup catalog", () => {
  beforeEach(() => {
    fetchBackups.mockReset();
    fetchBackups.mockResolvedValue({ ok: true, json: async () => page() });
  });
  it("retains the exact selected ID across pages and filters with bounded rows", async () => {
    fetchBackups.mockImplementation(async (url) => ({
      ok: true,
      json: async () =>
        new URL(String(url), "http://test").searchParams.get("page") === "2"
          ? page([b], 2)
          : page(),
    }));
    render(<Harness />);
    fireEvent.click(await screen.findByRole("radio", { name: /aaaaaaaa/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("radio", { name: /bbbbbbbb/ });
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    expect(screen.getByLabelText("Selected recovery point")).toHaveTextContent(
      a.id,
    );
    expect(screen.queryByText("Latest backup")).not.toBeInTheDocument();
    const before = fetchBackups.mock.calls.length;
    fireEvent.change(screen.getByRole("textbox", { name: "Search backups" }), {
      target: { value: "daily" },
    });
    expect(fetchBackups).toHaveBeenCalledTimes(before);
    search();
    await waitFor(() =>
      expect(String(fetchBackups.mock.calls.at(-1)?.[0])).toContain("q=daily"),
    );
    expect(
      new URL(
        String(fetchBackups.mock.calls.at(-1)?.[0]),
        "http://test",
      ).searchParams.get("page"),
    ).toBe("1");
    expect(screen.getByLabelText("Selected recovery point")).toHaveTextContent(
      a.id,
    );
  });
  it("sends date, host, tag, order and bounded page-size filters together", async () => {
    render(<Harness />);
    await screen.findByRole("radio");
    fireEvent.click(screen.getByRole("button", { name: "More filters" }));
    for (const [label, value] of [
      ["From date", "2026-10-01"],
      ["To date", "2026-10-14"],
      ["Host", "staging"],
      ["Tag", "daily"],
    ])
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.change(screen.getByRole("combobox", { name: "Backup order" }), {
      target: { value: "oldest" },
    });
    fireEvent.change(
      screen.getByRole("combobox", { name: "Backups per page" }),
      { target: { value: "100" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() =>
      expect(String(fetchBackups.mock.calls.at(-1)?.[0])).toContain("from="),
    );
    const query = new URL(
      String(fetchBackups.mock.calls.at(-1)?.[0]),
      "http://test",
    ).searchParams;
    expect(Object.fromEntries(query)).toMatchObject({
      from: "2026-10-01",
      to: "2026-10-14",
      host: "staging",
      tag: "daily",
      order: "oldest",
      pageSize: "100",
      page: "1",
    });
  });
  it("applies quick date ranges at once and removes single filters", async () => {
    render(<Harness />);
    await screen.findByRole("radio");
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    await waitFor(() => expect(fetchBackups).toHaveBeenCalledTimes(2));
    const query = new URL(
      String(fetchBackups.mock.calls.at(-1)?.[0]),
      "http://test",
    ).searchParams;
    const from = new Date(`${query.get("from")}T00:00:00Z`).getTime();
    const to = new Date(`${query.get("to")}T00:00:00Z`).getTime();
    expect((to - from) / 86400000).toBe(6);
    expect(screen.getByRole("button", { name: "7 days" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove from filter" }));
    await waitFor(() => expect(fetchBackups).toHaveBeenCalledTimes(3));
    expect(
      new URL(
        String(fetchBackups.mock.calls.at(-1)?.[0]),
        "http://test",
      ).searchParams.get("from"),
    ).toBe("");
    expect(screen.getByText("Custom range")).toBeInTheDocument();
  });
  it("ignores late responses and aborts superseded searches", async () => {
    let resolveOld!: (value: unknown) => void;
    fetchBackups
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValue({ ok: true, json: async () => page([b]) });
    render(<Harness />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search backups" }), {
      target: { value: "bbbb" },
    });
    search();
    await screen.findByRole("radio", { name: /bbbbbbbb/ });
    expect(fetchBackups.mock.calls[0][1].signal.aborted).toBe(true);
    resolveOld({ ok: true, json: async () => page([a]) });
    await waitFor(() =>
      expect(
        screen.queryByRole("radio", { name: /aaaaaaaa/ }),
      ).not.toBeInTheDocument(),
    );
  });
  it("clears filters without clearing selection, and reports empty results", async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByRole("radio"));
    fetchBackups.mockResolvedValue({
      ok: true,
      json: async () => ({ ...page([], 1), total: 0, pages: 1 }),
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Search backups" }), {
      target: { value: "none" },
    });
    search();
    await screen.findByText("No backups match these filters.");
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("textbox", { name: "Search backups" })).toHaveValue(
      "",
    );
    expect(screen.getByLabelText("Selected recovery point")).toHaveTextContent(
      a.id,
    );
  });
});
