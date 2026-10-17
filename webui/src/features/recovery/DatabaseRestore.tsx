import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Box,
  type BoxProps,
  Button,
  Flex,
  Grid,
  Heading,
  Input,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import {
  FiAlertTriangle,
  FiCheck,
  FiLock,
  FiRefreshCw,
  FiShield,
} from "react-icons/fi";
import { authenticatedFetch } from "../../api/client";
import {
  DialogActionTrigger,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogTitle,
} from "../../components/ui/dialog";
import { backendUrl } from "../../state/buildcfg";

import {
  BackupPicker,
  SelectedRecoveryPoint,
  formatAlgiers,
  type RecoverySnapshot,
} from "./BackupPicker";
export type RecoveryJob = {
  id: string;
  snapshotId: string;
  snapshotTime?: string;
  phase: string;
  rolledBack?: boolean;
  dumpSha256?: string;
  dumpBytes?: number;
  failureReason?: string;
  validation?: { tables: number; rows: number; schemaHash: string };
};
type RecoveryState = {
  environment: "staging";
  target: string;
  repoId: string;
  job?: RecoveryJob | null;
};

export function recoveryAction(job: RecoveryJob | null | undefined) {
  if (!job || job.phase === "aborted" || job.phase === "failed") return null;
  switch (job.phase) {
    case "validated":
      return {
        action: "freeze",
        label: "Pause staging",
        phrase: "PAUSE DZDISTRO STAGING",
      };
    case "frozen":
      return {
        action: "restore",
        label: "Restore staging database",
        phrase: `RESTORE DZDISTRO STAGING ${job.snapshotId.slice(0, 8)}`,
      };
    case "restored":
    case "rolled-back":
    case "resume-committed":
      return {
        action: "resume",
        label:
          job.phase === "resume-committed"
            ? "Finish resume cleanup"
            : "Resume staging",
        phrase: `RESUME DZDISTRO STAGING ${job.id.slice(0, 8)}`,
      };
    case "resumed":
      return job.rolledBack
        ? null
        : {
            action: "freeze-rollback",
            label: "Prepare rollback",
            phrase: "PAUSE DZDISTRO STAGING",
          };
    case "frozen-rollback":
      return {
        action: "rollback",
        label: "Roll back staging database",
        phrase: `ROLLBACK DZDISTRO STAGING ${job.id.slice(0, 8)}`,
      };
    default:
      return null;
  }
}

const descriptions: Record<string, string> = {
  preparing:
    "The encrypted snapshot is being restored into an isolated database. Current staging stays online.",
  validated:
    "The isolated restore passed. Its schema matches the current staging release. Current staging has not been replaced.",
  freezing: "Maintenance is being verified and staging is being paused.",
  frozen:
    "Staging is paused behind maintenance. Review the snapshot time before replacing its database.",
  switching:
    "The database switch is in progress. Refresh status rather than repeating the operation.",
  restored:
    "The selected snapshot is now the staging database. The previous database is retained for rollback. Staging stays behind maintenance until you resume it.",
  resuming:
    "Staging is resuming. Maintenance stays active until the checks finish.",
  "resume-committed":
    "All staging writers passed the resume checks and their resumed state is durably committed. Maintenance and lock cleanup still need to finish. This step does not repeat the database switch.",
  resumed:
    "Staging has resumed. The previous database remains available for a controlled rollback.",
  "frozen-rollback":
    "Staging is paused for rollback. The data created since the restore will also be retained separately.",
  "rolled-back":
    "The previous staging database is active again. Complete the resume checks before bringing staging online.",
  held: "Recovery stopped at a safety gate or an uncertain operation. Keep staging held and have an administrator inspect the recovery journal. Do not repeat the database switch.",
  containing:
    "The independent executor is completing containment after an interrupted resume. Keep maintenance active and refresh status; no further recovery action is available yet.",
  failed:
    "The test restore did not validate. Current staging was not replaced.",
  aborted:
    "The isolated test restore was discarded. Current staging was not replaced.",
};

// Phases the worker is still advancing; status refreshes itself while shown.
const transient = [
  "preparing",
  "freezing",
  "switching",
  "resuming",
  "containing",
];
const tones: Record<string, string> = {
  validated: "green",
  resumed: "green",
  failed: "red",
  held: "red",
  aborted: "gray",
  frozen: "orange",
  "frozen-rollback": "orange",
  restored: "blue",
  "rolled-back": "blue",
  "resume-committed": "blue",
};
const progress: Record<string, string> = {
  prepare:
    "Decrypting the snapshot and restoring it into an isolated database. This can take several minutes; keep this page open.",
  freeze: "Verifying maintenance and pausing staging…",
  "freeze-rollback": "Verifying maintenance and pausing staging…",
  restore: "Switching the staging database…",
  rollback: "Swapping the retained database back…",
  resume: "Running resume checks…",
  abort: "Discarding the isolated test database…",
};

/** Zero-based active step of the four-step workflow; 4 means complete. */
function currentStep(job: RecoveryJob | null | undefined) {
  switch (job?.phase) {
    case "validated":
    case "freezing":
      return 1;
    case "frozen":
    case "switching":
    case "frozen-rollback":
      return 2;
    case "restored":
    case "resuming":
    case "resume-committed":
    case "rolled-back":
      return 3;
    case "resumed":
      return 4;
    case "held":
    case "containing":
      return -1;
    default:
      return 0;
  }
}

function Stepper({ job }: { job: RecoveryJob | null | undefined }) {
  const active = currentStep(job);
  const rollback =
    job?.rolledBack ||
    job?.phase === "frozen-rollback" ||
    job?.phase === "rolled-back";
  const steps = [
    "Choose and test",
    "Pause staging",
    rollback ? "Roll back database" : "Switch database",
    "Reconcile and resume",
  ];
  return (
    <Grid
      as="ol"
      aria-label="Recovery steps"
      templateColumns={{ base: "1fr 1fr", md: "repeat(4, 1fr)" }}
      gap={2}
      mb={6}
      listStyleType="none"
    >
      {steps.map((label, index) => {
        const done = index < active;
        const current = index === active;
        return (
          <Flex
            as="li"
            key={label}
            align="center"
            gap={2.5}
            borderWidth="1px"
            borderRadius="lg"
            px={3}
            py={2.5}
            borderColor={current ? "blue.solid" : "border"}
            bg={current ? "blue.subtle/40" : undefined}
            aria-current={current ? "step" : undefined}
          >
            <Flex
              align="center"
              justify="center"
              boxSize={6}
              flexShrink={0}
              borderRadius="full"
              fontSize="xs"
              fontWeight="bold"
              bg={done ? "green.solid" : current ? "blue.solid" : "bg.muted"}
              color={done || current ? "white" : "fg.muted"}
            >
              {done ? <FiCheck /> : index + 1}
            </Flex>
            <Text
              fontSize="sm"
              fontWeight={current ? "semibold" : "medium"}
              color={done || current ? "fg" : "fg.muted"}
              lineHeight="short"
            >
              {label}
            </Text>
          </Flex>
        );
      })}
    </Grid>
  );
}

function Panel(props: BoxProps) {
  return (
    <Box
      borderWidth="1px"
      borderRadius="xl"
      bg="bg.panel"
      p={{ base: 4, md: 5 }}
      {...props}
    />
  );
}

export const DatabaseRestore = () => {
  const [state, setState] = useState<RecoveryState | null>(null);
  const [selected, setSelected] = useState<RecoverySnapshot | null>(null);
  const snapshotId = selected?.id || "";
  const [confirmation, setConfirmation] = useState("");
  const [reconciled, setReconciled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | undefined>();
  const [elapsed, setElapsed] = useState(0);
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState("");
  const requestVersion = useRef(0);
  const job = state?.job;
  const next = recoveryAction(job);
  const updateState = (result: RecoveryState) => {
    setState(result);
    setSelected((current) => {
      const active =
        result.job &&
        !["failed", "aborted", "resumed"].includes(result.job.phase);
      return active || (!current && result.job)
        ? { id: result.job!.snapshotId, time: result.job!.snapshotTime || "" }
        : current;
    });
  };

  const request = async (action?: string, phrase?: string) => {
    const version = ++requestVersion.current;
    setBusy(true);
    setPending(action);
    setError("");
    try {
      const response = await authenticatedFetch(
        `${backendUrl.replace(/\/$/, "")}/api/database-restore`,
        action
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action,
                ...(action === "prepare"
                  ? { snapshotId }
                  : { jobId: job?.id, confirmation: phrase }),
                ...(action === "resume"
                  ? { queuesReconciled: reconciled }
                  : {}),
              }),
            }
          : undefined,
      );
      let result: RecoveryState & { error?: string };
      try {
        result = await response.json();
      } catch {
        throw new Error("Sign in again or refresh the recovery status.");
      }
      if (version !== requestVersion.current) return;
      if (!response.ok) {
        if (action === "prepare") {
          try {
            const status = await authenticatedFetch(
              `${backendUrl.replace(/\/$/, "")}/api/database-restore`,
            );
            if (status.ok) {
              const current = await status.json();
              if (version === requestVersion.current) updateState(current);
            }
          } catch {
            // Preserve the test failure if its status cannot be refreshed.
          }
        }
        throw new Error(
          result.error ||
            "Recovery could not advance. Refresh its status before retrying.",
        );
      }
      updateState(result);
      setConfirmation("");
      setReconciled(false);
    } catch (e) {
      if (version === requestVersion.current)
        setError(e instanceof Error ? e.message : "Recovery request failed.");
    } finally {
      if (version === requestVersion.current) setBusy(false);
    }
  };

  useEffect(() => {
    void request();
    return () => {
      requestVersion.current++;
    };
  }, []);
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [busy]);
  // Read-only status polling while the worker advances a phase on its own.
  useEffect(() => {
    if (busy || !job || !transient.includes(job.phase)) return;
    const version = requestVersion.current;
    let active = true;
    let inFlight = false;
    const timer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await authenticatedFetch(
          `${backendUrl.replace(/\/$/, "")}/api/database-restore`,
        );
        if (response.ok) {
          const result = await response.json();
          if (active && version === requestVersion.current) updateState(result);
        }
      } catch {
        // The manual refresh remains available.
      } finally {
        inFlight = false;
      }
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [busy, job?.phase]);
  const openJob = job && !["failed", "aborted", "resumed"].includes(job.phase);
  const selectionDisabled = busy || !!openJob || !state;
  const canPrepare = !busy && !openJob && !!selected;
  const canAdvance =
    !busy &&
    !!next &&
    confirmation === next.phrase &&
    (next.action !== "resume" || reconciled);
  const destructive = next?.action === "restore" || next?.action === "rollback";
  const tone = job
    ? tones[job.phase] || (transient.includes(job.phase) ? "blue" : "gray")
    : "gray";

  return (
    <Box
      maxW="1200px"
      mx="auto"
      p={{ base: 4, lg: 8 }}
      pb={{ base: canPrepare ? 24 : 4, lg: 8 }}
    >
      <Flex justify="space-between" align="start" gap={3} mb={6} wrap="wrap">
        <Box>
          <Heading size="xl">Recover DZDistro staging</Heading>
          <Text color="fg.muted" mt={1}>
            Choose a recovery point, test it, then make a confirmed database
            switch.
          </Text>
        </Box>
        <Flex gap={2} wrap="wrap">
          <Badge size="lg" variant="surface" colorPalette="gray">
            <FiShield /> Encrypted with restic
          </Badge>
          <Badge size="lg" variant="solid" colorPalette="orange">
            Staging only
          </Badge>
        </Flex>
      </Flex>

      <Stepper job={job} />

      {job && (
        <Panel
          mb={5}
          aria-live="polite"
          borderColor={tone === "gray" ? "border" : `${tone}.muted`}
          borderTopWidth="4px"
          borderTopColor={tone === "gray" ? "border" : `${tone}.solid`}
        >
          <Grid
            templateColumns={{ base: "1fr", lg: next ? "1fr 1fr" : "1fr" }}
            gap={{ base: 5, lg: 8 }}
          >
            <Box>
              <Heading size="md" display="flex" alignItems="center" gap={2}>
                Recovery status:{" "}
                <Badge size="lg" colorPalette={tone}>
                  {job.phase.replaceAll("-", " ")}
                </Badge>
                {transient.includes(job.phase) && <Spinner size="xs" />}
              </Heading>
              <Text mt={3}>
                {job.phase === "resumed" && job.rolledBack
                  ? "Staging has resumed on the pre-recovery database. The post-restore database remains retained separately."
                  : descriptions[job.phase] ||
                    "Check the worker status before advancing."}
              </Text>
              {transient.includes(job.phase) && (
                <Text mt={2} fontSize="sm" color="fg.muted">
                  Status refreshes automatically every few seconds.
                </Text>
              )}
              {job.phase === "failed" && job.failureReason && (
                <Flex
                  role="alert"
                  gap={2}
                  align="start"
                  borderWidth="1px"
                  borderColor="red.muted"
                  bg="red.subtle"
                  color="red.fg"
                  borderRadius="md"
                  p={3}
                  mt={3}
                >
                  <Box mt={1}>
                    <FiAlertTriangle />
                  </Box>
                  <Text>{job.failureReason}</Text>
                </Flex>
              )}
              <Grid
                templateColumns="repeat(auto-fit, minmax(130px, 1fr))"
                gap={3}
                mt={4}
              >
                <Box bg="bg.muted" borderRadius="md" px={3} py={2}>
                  <Text fontSize="xs" color="fg.muted">
                    Snapshot
                  </Text>
                  <Text fontFamily="mono" fontWeight="semibold">
                    {job.snapshotId.slice(0, 8)}
                  </Text>
                  {job.snapshotTime && (
                    <Text fontSize="xs" color="fg.muted">
                      {formatAlgiers(job.snapshotTime, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}{" "}
                      Algiers
                    </Text>
                  )}
                </Box>
                {job.validation && (
                  <Box bg="bg.muted" borderRadius="md" px={3} py={2}>
                    <Text fontSize="xs" color="fg.muted">
                      Validation
                    </Text>
                    <Text fontWeight="semibold">
                      {job.validation.tables} tables ·{" "}
                      {job.validation.rows.toLocaleString()} rows inspected
                    </Text>
                  </Box>
                )}
              </Grid>
              {job.dumpSha256 && (
                <Box as="details" mt={3} fontSize="sm">
                  <Box as="summary" cursor="pointer" color="fg.muted">
                    Dump verification
                  </Box>
                  <Text
                    fontFamily="mono"
                    fontSize="xs"
                    overflowWrap="anywhere"
                    mt={2}
                  >
                    SHA256: {job.dumpSha256}
                  </Text>
                </Box>
              )}
              {job.phase === "resumed" && job.rolledBack && (
                <Text mt={3}>
                  Rollback completed. A further recovery starts with a new
                  snapshot validation.
                </Text>
              )}
              {["validated", "failed"].includes(job.phase) && (
                <Button
                  mt={4}
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setDiscarding(true)}
                >
                  Discard test restore
                </Button>
              )}
            </Box>
            {next && (
              <Box
                borderWidth="1px"
                borderRadius="lg"
                bg="bg.subtle"
                p={4}
                borderColor={destructive ? "red.muted" : "border"}
              >
                <Heading size="sm" mb={3}>
                  {next.action === "freeze" || next.action === "freeze-rollback"
                    ? "2. Pause staging"
                    : next.action === "resume"
                      ? "4. Check and resume staging"
                      : "3. Confirm the database switch"}
                </Heading>
                {next.action === "restore" && (
                  <Flex
                    gap={2}
                    mb={4}
                    fontWeight="medium"
                    color="red.fg"
                    align="start"
                  >
                    <Box mt={1}>
                      <FiAlertTriangle />
                    </Box>
                    <Text>
                      Staging will return to the selected backup. Changes made
                      after that backup will leave the active database; its
                      current data is preserved for rollback.
                    </Text>
                  </Flex>
                )}
                {next.action === "rollback" && (
                  <Text mb={4}>
                    Rollback restores the database preserved before recovery.
                    The current database will be retained separately.
                  </Text>
                )}
                {next.action === "resume" && (
                  <Box mb={4}>
                    <Flex
                      as="label"
                      gap={2.5}
                      align="start"
                      borderWidth="1px"
                      borderRadius="md"
                      bg="bg.panel"
                      p={3}
                      cursor="pointer"
                    >
                      <input
                        type="checkbox"
                        checked={reconciled}
                        style={{
                          marginTop: 4,
                          accentColor: "var(--chakra-colors-blue-500)",
                        }}
                        onChange={(e) => setReconciled(e.target.checked)}
                      />
                      <Text>
                        I have reconciled staging’s queued work and cached data
                        before allowing background processing to resume.
                      </Text>
                    </Flex>
                    <Text mt={2} fontSize="sm" color="fg.muted">
                      Pausing and resuming uses the same application containers;
                      migrations are not rerun.
                    </Text>
                  </Box>
                )}
                <Text mb={2} fontSize="sm">
                  Type the phrase below exactly to confirm.
                </Text>
                <Text
                  as="div"
                  fontFamily="mono"
                  fontWeight="bold"
                  bg="bg.muted"
                  borderRadius="md"
                  px={3}
                  py={2}
                  mb={2}
                  overflowWrap="anywhere"
                >
                  {next.phrase}
                </Text>
                <Input
                  aria-label="Recovery confirmation"
                  fontFamily="mono"
                  bg="bg.panel"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  mb={3}
                />
                <Button
                  w="full"
                  colorPalette={destructive ? "red" : "blue"}
                  disabled={!canAdvance}
                  onClick={() => void request(next.action, confirmation)}
                >
                  {next.label}
                </Button>
              </Box>
            )}
          </Grid>
        </Panel>
      )}

      <Grid
        templateColumns={{ base: "1fr", lg: "minmax(0, 1fr) 340px" }}
        gap={5}
        alignItems="start"
      >
        <Panel>
          <Heading size="md" mb={1}>
            1. Choose a recovery point
          </Heading>
          <Text color="fg.muted" fontSize="sm" mb={4}>
            Backups remain encrypted with restic. Testing creates an isolated
            database; it does not overwrite staging.
          </Text>
          <BackupPicker
            selected={selected}
            disabled={!!selectionDisabled}
            onSelect={(snapshot) => {
              setSelected(snapshot);
              setError("");
            }}
          />
        </Panel>
        <Stack gap={4} position={{ lg: "sticky" }} top={{ lg: 4 }}>
          <SelectedRecoveryPoint
            selected={selected}
            disabled={!!selectionDisabled}
            onClear={() => setSelected(null)}
          />
          {openJob ? (
            <Flex
              gap={2}
              align="start"
              fontSize="sm"
              color="fg.muted"
              borderWidth="1px"
              borderRadius="lg"
              p={3}
            >
              <Box mt={0.5}>
                <FiLock />
              </Box>
              <Text>
                Backup selection is locked while this recovery is open. Finish
                or discard it to test another backup.
              </Text>
            </Flex>
          ) : (
            <Box>
              <Button
                w="full"
                size="lg"
                disabled={!canPrepare}
                onClick={() => void request("prepare")}
              >
                Test restore into isolated database
              </Button>
              <Text fontSize="xs" color="fg.muted" mt={2} textAlign="center">
                Staging stays online. Nothing is replaced until you confirm.
              </Text>
            </Box>
          )}
          {busy && (
            <Flex
              role="status"
              gap={3}
              align="start"
              borderWidth="1px"
              borderColor="blue.muted"
              bg="blue.subtle/40"
              borderRadius="lg"
              p={3}
            >
              <Spinner size="sm" mt={0.5} color="blue.fg" />
              <Box fontSize="sm">
                <Text fontWeight="medium">
                  {(pending && progress[pending]) ||
                    "Refreshing recovery status…"}
                </Text>
                {elapsed >= 3 && (
                  <Text color="fg.muted" fontVariantNumeric="tabular-nums">
                    {Math.floor(elapsed / 60)}:
                    {String(elapsed % 60).padStart(2, "0")} elapsed
                  </Text>
                )}
              </Box>
            </Flex>
          )}
          {error && error !== job?.failureReason && (
            <Flex
              role="alert"
              gap={2}
              align="start"
              borderWidth="1px"
              borderColor="red.muted"
              bg="red.subtle"
              color="red.fg"
              borderRadius="lg"
              p={3}
              fontSize="sm"
            >
              <Box mt={0.5}>
                <FiAlertTriangle />
              </Box>
              <Text>{error}</Text>
            </Flex>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void request()}
          >
            <FiRefreshCw /> Refresh recovery status
          </Button>
          <Text color="fg.muted" fontSize="xs">
            This workflow covers the staging database. Uploads and application
            secrets are outside this backup. Retained recovery databases require
            separate cleanup.
          </Text>
        </Stack>
      </Grid>

      {canPrepare && selected && (
        // Small screens keep the next step in reach below a long backup list.
        <Flex
          display={{ base: "flex", lg: "none" }}
          position="fixed"
          insetX={0}
          bottom={0}
          zIndex="sticky"
          gap={3}
          align="center"
          justify="space-between"
          borderTopWidth="1px"
          bg="bg.panel"
          px={4}
          py={3}
          shadow="lg"
        >
          <Box minW={0}>
            <Text fontSize="xs" color="fg.muted">
              Selected
            </Text>
            <Text fontSize="sm" fontWeight="semibold" truncate>
              <Box as="span" fontFamily="mono">
                {selected.id.slice(0, 8)}
              </Box>
              {selected.time &&
                ` · ${formatAlgiers(selected.time, { dateStyle: "medium", timeStyle: "short" })}`}
            </Text>
          </Box>
          <Button
            size="sm"
            flexShrink={0}
            onClick={() => void request("prepare")}
          >
            Test this backup
          </Button>
        </Flex>
      )}
      <DialogRoot
        open={discarding}
        onOpenChange={(event) => setDiscarding(event.open)}
        role="alertdialog"
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard test restore?</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <Text>
              Only this isolated test database is removed. Current staging and
              the encrypted backups stay intact.
            </Text>
          </DialogBody>
          <DialogFooter>
            <DialogActionTrigger asChild>
              <Button variant="outline">Keep it</Button>
            </DialogActionTrigger>
            <Button
              colorPalette="red"
              disabled={busy || !job}
              onClick={() => {
                setDiscarding(false);
                if (job)
                  void request(
                    "abort",
                    `DISCARD TEST RESTORE ${job.id.slice(0, 8)}`,
                  );
              }}
            >
              Discard test restore
            </Button>
          </DialogFooter>
        </DialogContent>
      </DialogRoot>
    </Box>
  );
};
