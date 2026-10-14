import { useEffect, useState } from "react";
import { Box, Button, Flex, Input, NativeSelect, Text } from "@chakra-ui/react";
import { authenticatedFetch } from "../../api/client";
import { backendUrl } from "../../state/buildcfg";

export type RecoverySnapshot = {
  id: string;
  time: string;
  hostname?: string;
  tags?: string[];
};
type Page = {
  snapshots: RecoverySnapshot[];
  total: number;
  available: number;
  page: number;
  pageSize: number;
  pages: number;
  latestId: string;
};
const emptyFilters = {
  q: "",
  from: "",
  to: "",
  host: "",
  tag: "",
  order: "newest",
  pageSize: "25",
};

export function BackupPicker({
  selected,
  onSelect,
  disabled,
}: {
  selected: RecoverySnapshot | null;
  onSelect: (snapshot: RecoverySnapshot | null) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState(emptyFilters);
  const [query, setQuery] = useState({ ...emptyFilters, page: 1 });
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError("");
    const parameters = new URLSearchParams({
      view: "snapshots",
      ...query,
      page: String(query.page),
    });
    if (refresh) parameters.set("refresh", "true");
    void (async () => {
      try {
        const response = await authenticatedFetch(
          `${backendUrl.replace(/\/$/, "")}/api/database-restore?${parameters}`,
          { signal: controller.signal },
        );
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error || "Backups could not be loaded.");
        if (active) setPage(result);
      } catch (e) {
        if (active)
          setError(
            e instanceof Error ? e.message : "Backups could not be loaded.",
          );
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [query, refresh]);
  const field = (name: keyof typeof emptyFilters, value: string) =>
    setDraft((current) => ({ ...current, [name]: value }));
  return (
    <Box>
      <Box
        as="form"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery({ ...draft, page: 1 });
          setRefresh(0);
        }}
        mb={4}
      >
        <Input
          aria-label="Search backups"
          placeholder="Search snapshot ID, host or tag"
          value={draft.q}
          maxLength={128}
          onChange={(event) => field("q", event.target.value)}
          mb={3}
        />
        <Flex gap={3} wrap="wrap" align="end">
          {(
            [
              ["from", "From date"],
              ["to", "To date"],
              ["host", "Host"],
              ["tag", "Tag"],
            ] as const
          ).map(([name, label]) => (
            <Box as="label" key={name} flex="1" minW="145px">
              <Text fontSize="sm" mb={1}>
                {label}
              </Text>
              <Input
                type={name === "from" || name === "to" ? "date" : "text"}
                aria-label={label}
                value={draft[name]}
                maxLength={128}
                onChange={(event) => field(name, event.target.value)}
              />
            </Box>
          ))}
          <Box as="label" flex="1" minW="145px">
            <Text fontSize="sm" mb={1}>
              Order
            </Text>
            <NativeSelect.Root>
              <NativeSelect.Field
                aria-label="Backup order"
                value={draft.order}
                onChange={(event) => field("order", event.target.value)}
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
          </Box>
          <Box as="label" minW="110px">
            <Text fontSize="sm" mb={1}>
              Per page
            </Text>
            <NativeSelect.Root>
              <NativeSelect.Field
                aria-label="Backups per page"
                value={draft.pageSize}
                onChange={(event) => field("pageSize", event.target.value)}
              >
                {[25, 50, 100].map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
          </Box>
        </Flex>
        <Flex gap={2} wrap="wrap" mt={3}>
          <Button type="submit" size="sm">
            Apply filters
          </Button>
          <Button
          type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setDraft(emptyFilters);
              setQuery({ ...emptyFilters, page: 1 });
              setRefresh(0);
            }}
          >
            Clear filters
          </Button>
          <Button
          type="button"
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            Refresh backups
          </Button>
        </Flex>
        <Text color="fg.muted" fontSize="xs" mt={2}>
          Dates and times in Algiers (UTC+1). Host and tag filters use exact
          matches.
        </Text>
      </Box>
      {selected && (
        <Box
          borderWidth="1px"
          borderColor="blue.500"
          borderRadius="md"
          p={3}
          mb={3}
          aria-label="Selected recovery point"
        >
          <Flex gap={2} justify="space-between" align="center">
            <Text fontWeight="semibold">Selected recovery point</Text>
            <Button
              variant="plain"
              size="xs"
              disabled={disabled}
              onClick={() => onSelect(null)}
            >
              Clear selection
            </Button>
          </Flex>
          <Text fontSize="sm" overflowWrap="anywhere">
            {selected.id}
          </Text>
          {selected.time && (
            <Text fontSize="sm" color="fg.muted">
              {new Date(selected.time).toLocaleString(undefined, {
                timeZone: "Africa/Algiers",
                hour12: false,
              })}{" "}
              Algiers
            </Text>
          )}
          <Text fontSize="xs" color="fg.muted">
            Selection stays when you change filters or pages.
          </Text>
        </Box>
      )}
      {error && (
        <Box role="alert" color="red.fg" mb={3}>
          {error}
        </Box>
      )}
      <fieldset
        disabled={disabled || loading || !!error}
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
      >
        <legend>Available backups</legend>
        <Box aria-busy={loading} maxH="420px" overflowY="auto" mb={3}>
          {loading ? (
            <Text py={3} role="status">
              Loading backups…
            </Text>
          ) : (
            !error &&
            page?.snapshots.map((snapshot) => {
              const date = new Date(snapshot.time);
              const day = date.toLocaleDateString(undefined, {
                day: "numeric",
                month: "long",
                year: "numeric",
                timeZone: "Africa/Algiers",
              });
              const time = date.toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
                timeZone: "Africa/Algiers",
              });
              const checked = selected?.id === snapshot.id;
              return (
                <Flex
                  as="label"
                  key={snapshot.id}
                  align="center"
                  gap={3}
                  p={3}
                  mb={2}
                  borderWidth="1px"
                  borderColor={checked ? "blue.500" : "border"}
                  bg={checked ? "bg.subtle" : "bg.panel"}
                  borderRadius="md"
                  cursor={disabled ? "not-allowed" : "pointer"}
                  css={{
                    "&:focus-within": {
                      outline: "2px solid",
                      outlineColor: "blue.500",
                      outlineOffset: "-2px",
                    },
                  }}
                >
                  <input
                    type="radio"
                    name="recovery-snapshot"
                    checked={checked}
                    value={snapshot.id}
                    aria-label={`Backup ${day} at ${time} Algiers, snapshot ${snapshot.id.slice(0, 8)}`}
                    onChange={() => onSelect(snapshot)}
                  />
                  <Box flex="1" minW={0}>
                    <Flex gap={2} align="center" wrap="wrap">
                      <Text fontWeight="semibold">{day}</Text>
                      {snapshot.id === page.latestId && (
                        <Text color="blue.fg" fontSize="xs" fontWeight="bold">
                          Latest backup
                        </Text>
                      )}
                    </Flex>
                    <Text color="fg.muted" fontSize="sm">
                      {time} · Snapshot {snapshot.id.slice(0, 8)}
                    </Text>
                    {(snapshot.hostname || !!snapshot.tags?.length) && (
                      <Text
                        fontSize="xs"
                        color="fg.muted"
                        truncate
                        title={[snapshot.hostname, ...(snapshot.tags || [])]
                          .filter(Boolean)
                          .join(" · ")}
                      >
                        {snapshot.hostname}
                        {snapshot.tags?.length
                          ? ` · ${snapshot.tags.join(", ")}`
                          : ""}
                      </Text>
                    )}
                  </Box>
                  {checked && (
                    <Text fontSize="sm" fontWeight="bold">
                      Selected
                    </Text>
                  )}
                </Flex>
              );
            })
          )}
          {!loading && !error && page?.total === 0 && (
            <Text py={3}>No backups match these filters.</Text>
          )}
        </Box>
      </fieldset>
      {page && !loading && !error && (
        <Flex
          as="nav"
          aria-label="Backup pages"
          gap={3}
          align="center"
          wrap="wrap"
          mb={4}
        >
          <Text flex="1" fontSize="sm" role="status">
            {page.total
              ? `${(page.page - 1) * page.pageSize + 1}–${Math.min(page.page * page.pageSize, page.total)}`
              : "0"}{" "}
            of {page.total.toLocaleString()} matching ·{" "}
            {page.available.toLocaleString()} backups
          </Text>
          <Button
            variant="outline"
            size="sm"
            disabled={page.page === 1}
            onClick={() => {
              setQuery((value) => ({ ...value, page: 1 }));
              setRefresh(0);
            }}
          >
            First
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page.page === 1}
            onClick={() => {
              setQuery((value) => ({ ...value, page: page.page - 1 }));
              setRefresh(0);
            }}
          >
            Previous
          </Button>
          <Text fontSize="sm">
            Page {page.page} of {page.pages.toLocaleString()}
          </Text>
          <Button
            variant="outline"
            size="sm"
            disabled={page.page === page.pages}
            onClick={() => {
              setQuery((value) => ({ ...value, page: page.page + 1 }));
              setRefresh(0);
            }}
          >
            Next
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page.page === page.pages}
            onClick={() => {
              setQuery((value) => ({ ...value, page: page.pages }));
              setRefresh(0);
            }}
          >
            Last
          </Button>
        </Flex>
      )}
    </Box>
  );
}
