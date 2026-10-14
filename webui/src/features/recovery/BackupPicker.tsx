import { useEffect, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Flex,
  Grid,
  IconButton,
  Input,
  NativeSelect,
  Skeleton,
  Stack,
  Text,
} from "@chakra-ui/react";
import {
  FiCheck,
  FiChevronLeft,
  FiChevronRight,
  FiChevronsLeft,
  FiChevronsRight,
  FiCopy,
  FiDatabase,
  FiFilter,
  FiRefreshCw,
  FiSearch,
  FiX,
} from "react-icons/fi";
import { authenticatedFetch } from "../../api/client";
import { InputGroup } from "../../components/ui/input-group";
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
type Filters = typeof emptyFilters;
const emptyFilters = {
  q: "",
  from: "",
  to: "",
  host: "",
  tag: "",
  order: "newest",
  pageSize: "25",
};
const zone = "Africa/Algiers";

/** Calendar date in Algiers as YYYY-MM-DD, matching the server's date filters. */
function algiersDate(date: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(date);
}
function shiftDays(day: string, days: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function ranges() {
  const today = algiersDate(new Date());
  return [
    { label: "All time", from: "", to: "" },
    { label: "Today", from: today, to: today },
    { label: "7 days", from: shiftDays(today, -6), to: today },
    { label: "30 days", from: shiftDays(today, -29), to: today },
    { label: "90 days", from: shiftDays(today, -89), to: today },
  ];
}

export function formatAlgiers(
  time: string,
  options: Intl.DateTimeFormatOptions,
) {
  return new Date(time).toLocaleString(undefined, {
    timeZone: zone,
    hour12: false,
    ...options,
  });
}

/** Coarse age of a recovery point, e.g. "3 hours ago". */
export function relativeAge(time: string, now = Date.now()) {
  const seconds = (new Date(time).getTime() - now) / 1000;
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ] as const)
    if (Math.abs(seconds) >= size)
      return format.format(Math.round(seconds / size), unit);
  return "just now";
}

export function SelectedRecoveryPoint({
  selected,
  onClear,
  disabled,
}: {
  selected: RecoverySnapshot | null;
  onClear: () => void;
  disabled: boolean;
}) {
  const [copied, setCopied] = useState(false);
  if (!selected)
    return (
      <Flex
        direction="column"
        align="center"
        textAlign="center"
        gap={2}
        borderWidth="1px"
        borderStyle="dashed"
        borderRadius="lg"
        p={5}
        color="fg.muted"
      >
        <FiDatabase size={22} />
        <Text fontWeight="medium" color="fg">
          No recovery point selected
        </Text>
        <Text fontSize="sm">
          Choose a backup from before the incident. Nothing changes until you
          test it.
        </Text>
      </Flex>
    );
  return (
    <Box
      borderWidth="1px"
      borderColor="blue.solid"
      bg="blue.subtle/40"
      borderRadius="lg"
      p={4}
      aria-label="Selected recovery point"
    >
      <Flex justify="space-between" align="center" gap={2} mb={2}>
        <Text
          fontSize="xs"
          fontWeight="semibold"
          textTransform="uppercase"
          letterSpacing="wider"
          color="blue.fg"
        >
          Selected recovery point
        </Text>
        <Button
          variant="ghost"
          size="2xs"
          disabled={disabled}
          onClick={onClear}
        >
          <FiX /> Clear selection
        </Button>
      </Flex>
      {selected.time && (
        <>
          <Text fontSize="lg" fontWeight="semibold" lineHeight="short">
            {formatAlgiers(selected.time, {
              weekday: "short",
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </Text>
          <Text fontSize="sm" color="fg.muted" mb={3}>
            {formatAlgiers(selected.time, {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}{" "}
            Algiers · {relativeAge(selected.time)}
          </Text>
        </>
      )}
      <Flex align="start" gap={2} bg="bg.muted" borderRadius="md" px={3} py={2}>
        <Text
          flex="1"
          fontFamily="mono"
          fontSize="xs"
          lineHeight="tall"
          overflowWrap="anywhere"
        >
          {selected.id}
        </Text>
        <IconButton
          aria-label={copied ? "Snapshot ID copied" : "Copy snapshot ID"}
          title={copied ? "Copied" : "Copy full snapshot ID"}
          variant="ghost"
          size="2xs"
          onClick={() =>
            void navigator.clipboard?.writeText(selected.id).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? <FiCheck /> : <FiCopy />}
        </IconButton>
      </Flex>
      <Text fontSize="xs" color="fg.muted" mt={2}>
        Selection stays when you change filters or pages.
      </Text>
    </Box>
  );
}

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
  const [showFilters, setShowFilters] = useState(false);
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
  const field = (name: keyof Filters, value: string) =>
    setDraft((current) => ({ ...current, [name]: value }));
  // Applies the given filters immediately, returning to the first page.
  const apply = (changes: Partial<Filters>) => {
    setDraft((current) => ({ ...current, ...changes }));
    setQuery((current) => ({ ...current, ...changes, page: 1 }));
    setRefresh(0);
  };
  const goTo = (number: number) => {
    setQuery((value) => ({ ...value, page: number }));
    setRefresh(0);
  };
  const presets = ranges();
  const activeRange = presets.find(
    (range) => range.from === query.from && range.to === query.to,
  );
  const chips = (
    [
      ["q", "Search"],
      ["from", "From"],
      ["to", "To"],
      ["host", "Host"],
      ["tag", "Tag"],
    ] as const
  ).filter(([name]) => query[name]);
  const groups: { day: string; snapshots: RecoverySnapshot[] }[] = [];
  for (const snapshot of page?.snapshots || []) {
    const day = algiersDate(new Date(snapshot.time));
    if (groups.at(-1)?.day !== day) groups.push({ day, snapshots: [] });
    groups.at(-1)!.snapshots.push(snapshot);
  }
  return (
    <Box>
      <Box
        as="form"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery({ ...draft, page: 1 });
          setRefresh(0);
        }}
      >
        <Flex gap={2}>
          <InputGroup flex="1" startElement={<FiSearch />}>
            <Input
              aria-label="Search backups"
              placeholder="Search snapshot ID, host or tag"
              value={draft.q}
              maxLength={128}
              onChange={(event) => field("q", event.target.value)}
            />
          </InputGroup>
          <Button
            type="button"
            variant={showFilters ? "subtle" : "outline"}
            aria-label="More filters"
            aria-expanded={showFilters}
            aria-controls="backup-filters"
            onClick={() => setShowFilters((value) => !value)}
          >
            <FiFilter />
            <Box as="span" display={{ base: "none", sm: "inline" }}>
              More filters
            </Box>
          </Button>
          <IconButton
            type="button"
            variant="outline"
            aria-label="Refresh backups"
            title="Reload the backup catalog from the repository"
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <FiRefreshCw />
          </IconButton>
        </Flex>
        <Flex
          gap={1.5}
          mt={3}
          wrap="wrap"
          align="center"
          role="group"
          aria-label="Backup date range"
        >
          {presets.map((range) => (
            <Button
              key={range.label}
              type="button"
              size="xs"
              borderRadius="full"
              variant={activeRange === range ? "solid" : "outline"}
              aria-pressed={activeRange === range}
              onClick={() => apply({ from: range.from, to: range.to })}
            >
              {range.label}
            </Button>
          ))}
          {!activeRange && (
            <Badge size="lg" borderRadius="full" colorPalette="blue">
              Custom range
            </Badge>
          )}
        </Flex>
        {showFilters && (
          <Box
            id="backup-filters"
            borderWidth="1px"
            borderRadius="lg"
            bg="bg.subtle"
            p={4}
            mt={3}
          >
            <Grid
              templateColumns={{
                base: "1fr",
                sm: "1fr 1fr",
                md: "repeat(4, 1fr)",
              }}
              gap={3}
            >
              {(
                [
                  ["from", "From date"],
                  ["to", "To date"],
                  ["host", "Host"],
                  ["tag", "Tag"],
                ] as const
              ).map(([name, label]) => (
                <Box as="label" key={name} minW={0}>
                  <Text fontSize="xs" fontWeight="medium" mb={1}>
                    {label}
                  </Text>
                  <Input
                    size="sm"
                    bg="bg.panel"
                    type={name === "from" || name === "to" ? "date" : "text"}
                    aria-label={label}
                    placeholder={
                      name === "host"
                        ? "Exact hostname"
                        : name === "tag"
                          ? "Exact tag"
                          : undefined
                    }
                    value={draft[name]}
                    maxLength={128}
                    onChange={(event) => field(name, event.target.value)}
                  />
                </Box>
              ))}
            </Grid>
            <Flex gap={3} mt={3} align="center" wrap="wrap">
              <Button type="submit" size="sm">
                Apply filters
              </Button>
              <Text color="fg.muted" fontSize="xs">
                Dates are inclusive Algiers (UTC+1) calendar days. Host and tag
                use exact matches.
              </Text>
            </Flex>
          </Box>
        )}
        {/* Enter in the search box submits; the hidden button keeps that
            working while the filter panel is closed. */}
        {!showFilters && <button type="submit" hidden />}
      </Box>
      {chips.length > 0 && (
        <Flex gap={1.5} mt={3} wrap="wrap" align="center">
          <Text fontSize="xs" color="fg.muted" mr={1}>
            Filtered by
          </Text>
          {chips.map(([name, label]) => (
            <Badge
              key={name}
              size="md"
              variant="surface"
              borderRadius="full"
              pe={1}
            >
              {label}: {query[name]}
              <IconButton
                aria-label={`Remove ${label.toLowerCase()} filter`}
                variant="plain"
                size="2xs"
                minW={4}
                h={4}
                onClick={() => apply({ [name]: "" })}
              >
                <FiX />
              </IconButton>
            </Badge>
          ))}
          <Button
            type="button"
            variant="plain"
            size="xs"
            color="fg.muted"
            onClick={() => {
              setDraft(emptyFilters);
              setQuery({ ...emptyFilters, page: 1 });
              setRefresh(0);
            }}
          >
            Clear filters
          </Button>
        </Flex>
      )}

      <Flex
        mt={4}
        mb={2}
        gap={3}
        align="center"
        justify="space-between"
        wrap="wrap"
      >
        <Text fontSize="sm" color="fg.muted" role="status" aria-live="polite">
          {loading
            ? "Loading backups…"
            : page && !error
              ? page.total === page.available
                ? `${page.available.toLocaleString()} backups`
                : `${page.total.toLocaleString()} matching of ${page.available.toLocaleString()} backups`
              : ""}
        </Text>
        <Flex gap={2}>
          <NativeSelect.Root size="xs" width="auto">
            <NativeSelect.Field
              aria-label="Backup order"
              value={draft.order}
              onChange={(event) => apply({ order: event.target.value })}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
          <NativeSelect.Root size="xs" width="auto">
            <NativeSelect.Field
              aria-label="Backups per page"
              value={draft.pageSize}
              onChange={(event) => apply({ pageSize: event.target.value })}
            >
              {[25, 50, 100].map((size) => (
                <option key={size} value={size}>
                  {size} per page
                </option>
              ))}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        </Flex>
      </Flex>

      {error && (
        <Flex
          role="alert"
          align="center"
          justify="space-between"
          gap={3}
          borderWidth="1px"
          borderColor="red.muted"
          bg="red.subtle"
          color="red.fg"
          borderRadius="md"
          px={4}
          py={3}
          mb={3}
        >
          <Text fontSize="sm">{error}</Text>
          <Button
            size="xs"
            variant="outline"
            onClick={() => setRefresh((value) => value + 1)}
          >
            Try again
          </Button>
        </Flex>
      )}
      <fieldset
        disabled={disabled || loading || !!error}
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
      >
        <Box as="legend" srOnly>
          Available backups
        </Box>
        <Box
          aria-busy={loading}
          borderWidth="1px"
          borderRadius="lg"
          maxH={{ base: "none", lg: "560px" }}
          overflowY="auto"
          opacity={disabled && !loading ? 0.6 : 1}
        >
          {loading ? (
            <Stack gap={0} p={2}>
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} h="44px" m={1} borderRadius="md" />
              ))}
            </Stack>
          ) : (
            !error &&
            groups.map(({ day, snapshots }) => (
              <Box key={day} role="group" aria-label={day}>
                <Flex
                  position="sticky"
                  top={0}
                  zIndex={1}
                  bg="bg.muted"
                  borderBottomWidth="1px"
                  px={4}
                  py={1.5}
                  justify="space-between"
                  fontSize="xs"
                >
                  <Text fontWeight="semibold">
                    {formatAlgiers(snapshots[0].time, {
                      weekday: "long",
                      day: "numeric",
                      month: "long",
                      year: "numeric",
                    })}
                  </Text>
                  <Text color="fg.muted">
                    {snapshots.length}{" "}
                    {snapshots.length === 1 ? "backup" : "backups"}
                  </Text>
                </Flex>
                {snapshots.map((snapshot) => {
                  const date = new Date(snapshot.time);
                  const dayLabel = date.toLocaleDateString(undefined, {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                    timeZone: zone,
                  });
                  const time = date.toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                    timeZone: zone,
                  });
                  const checked = selected?.id === snapshot.id;
                  return (
                    <Flex
                      as="label"
                      key={snapshot.id}
                      align="center"
                      gap={3}
                      px={4}
                      py={2.5}
                      borderBottomWidth="1px"
                      borderLeftWidth="3px"
                      borderLeftColor={checked ? "blue.solid" : "transparent"}
                      bg={checked ? "blue.subtle/50" : undefined}
                      cursor={disabled ? "not-allowed" : "pointer"}
                      _hover={disabled || checked ? {} : { bg: "bg.subtle" }}
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
                        style={{ accentColor: "var(--chakra-colors-blue-500)" }}
                        aria-label={`Backup ${dayLabel} at ${time} Algiers, snapshot ${snapshot.id.slice(0, 8)}`}
                        onChange={() => onSelect(snapshot)}
                      />
                      <Text
                        fontWeight="semibold"
                        fontVariantNumeric="tabular-nums"
                        w="3.25rem"
                        flexShrink={0}
                      >
                        {time}
                      </Text>
                      <Text
                        fontFamily="mono"
                        fontSize="sm"
                        color="fg.muted"
                        flexShrink={0}
                        title={snapshot.id}
                      >
                        {snapshot.id.slice(0, 8)}
                      </Text>
                      <Flex
                        flex="1"
                        minW={0}
                        gap={1}
                        wrap="wrap"
                        align="center"
                        display={{ base: "none", md: "flex" }}
                      >
                        {snapshot.hostname && (
                          <Text fontSize="xs" color="fg.muted" me={1}>
                            {snapshot.hostname}
                          </Text>
                        )}
                        {snapshot.tags?.map((tag) => (
                          <Badge key={tag} size="sm" variant="subtle">
                            {tag}
                          </Badge>
                        ))}
                      </Flex>
                      <Flex
                        flex={{ base: "1", md: "none" }}
                        justify="end"
                        gap={2}
                        align="center"
                      >
                        {snapshot.id === page?.latestId && (
                          <Badge size="sm" colorPalette="green">
                            Latest backup
                          </Badge>
                        )}
                        {checked && (
                          <Flex
                            align="center"
                            gap={1}
                            color="blue.fg"
                            fontSize="sm"
                            fontWeight="semibold"
                          >
                            <FiCheck /> Selected
                          </Flex>
                        )}
                      </Flex>
                    </Flex>
                  );
                })}
              </Box>
            ))
          )}
          {!loading && !error && page?.total === 0 && (
            <Flex direction="column" align="center" gap={1} py={10} px={4}>
              <FiSearch size={20} />
              <Text fontWeight="medium">No backups match these filters.</Text>
              <Text fontSize="sm" color="fg.muted">
                Widen the date range or clear the filters.
              </Text>
            </Flex>
          )}
        </Box>
      </fieldset>
      {page && !loading && !error && page.total > 0 && (
        <Flex
          as="nav"
          aria-label="Backup pages"
          gap={1}
          align="center"
          justify={{ base: "center", sm: "start" }}
          mt={3}
        >
          <Text
            flex="1"
            fontSize="sm"
            color="fg.muted"
            minW="max-content"
            display={{ base: "none", sm: "block" }}
          >
            {`${(page.page - 1) * page.pageSize + 1}–${Math.min(page.page * page.pageSize, page.total)}`}{" "}
            of {page.total.toLocaleString()}
          </Text>
          <IconButton
            aria-label="First"
            variant="ghost"
            size="sm"
            disabled={page.page === 1}
            onClick={() => goTo(1)}
          >
            <FiChevronsLeft />
          </IconButton>
          <IconButton
            aria-label="Previous"
            variant="ghost"
            size="sm"
            disabled={page.page === 1}
            onClick={() => goTo(page.page - 1)}
          >
            <FiChevronLeft />
          </IconButton>
          <Text fontSize="sm" px={2} fontVariantNumeric="tabular-nums">
            Page {page.page.toLocaleString()} of {page.pages.toLocaleString()}
          </Text>
          <IconButton
            aria-label="Next"
            variant="ghost"
            size="sm"
            disabled={page.page === page.pages}
            onClick={() => goTo(page.page + 1)}
          >
            <FiChevronRight />
          </IconButton>
          <IconButton
            aria-label="Last"
            variant="ghost"
            size="sm"
            disabled={page.page === page.pages}
            onClick={() => goTo(page.pages)}
          >
            <FiChevronsRight />
          </IconButton>
        </Flex>
      )}
    </Box>
  );
}
