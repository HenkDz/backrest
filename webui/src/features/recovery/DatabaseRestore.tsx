import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Flex,
  Heading,
  Input,
  NativeSelect,
  Spinner,
  Text,
} from "@chakra-ui/react";
import { authenticatedFetch } from "../../api/client";
import { backendUrl } from "../../state/buildcfg";

type Snapshot = { id: string; time: string };
export type RecoveryJob = {
  id: string;
  snapshotId: string;
  snapshotTime?: string;
  phase: string;
  rolledBack?: boolean;
  dumpSha256?: string;
  dumpBytes?: number;
  validation?: { tables: number; rows: number; schemaHash: string };
};
type RecoveryState = {
  environment: "staging";
  target: string;
  repoId: string;
  snapshots: Snapshot[];
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

export const DatabaseRestore = () => {
  const [state, setState] = useState<RecoveryState | null>(null);
  const [snapshotId, setSnapshotId] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [reconciled, setReconciled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const job = state?.job;
  const next = recoveryAction(job);

  const request = async (action?: string, phrase?: string) => {
    setBusy(true);
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
      if (!response.ok)
        throw new Error(
          result.error ||
            "Recovery could not advance. Refresh its status before retrying.",
        );
      setState(result);
      setConfirmation("");
      setReconciled(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Recovery request failed.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void request();
  }, []);
  const openJob = job && !["failed", "aborted", "resumed"].includes(job.phase);
  const canPrepare = !busy && !!snapshotId && !openJob;
  const canAdvance =
    !busy &&
    !!next &&
    confirmation === next.phrase &&
    (next.action !== "resume" || reconciled);

  return (
    <Box maxW="900px" mx="auto" p={{ base: 4, lg: 8 }}>
      <Flex justify="space-between" align="center" gap={3} mb={6} wrap="wrap">
        <Box>
          <Heading size="lg">Recover DZDistro staging</Heading>
          <Text color="fg.muted" mt={2}>
            Choose a recovery point, test it, then make a confirmed database
            switch.
          </Text>
        </Box>
        <Text
          borderWidth="1px"
          borderRadius="md"
          px={3}
          py={1}
          fontWeight="bold"
        >
          Staging only
        </Text>
      </Flex>
      <Box borderWidth="1px" borderRadius="lg" p={5} mb={5}>
        <Heading size="sm" mb={3}>
          1. Select and validate a backup
        </Heading>
        <Text mb={4}>
          Backups remain encrypted with restic. Testing creates an isolated
          database; it does not overwrite staging.
        </Text>
        <label htmlFor="recovery-snapshot">Recovery snapshot</label>
        <NativeSelect.Root mt={2} mb={4} disabled={busy || !!openJob || !state}>
          <NativeSelect.Field
            id="recovery-snapshot"
            value={snapshotId}
            onChange={(event: React.ChangeEvent<HTMLSelectElement>) =>
              setSnapshotId(event.target.value)
            }
            display="block"
            width="full"
            bg="bg.panel"
            borderWidth="1px"
            borderRadius="md"
            p={3}
            mt={2}
            mb={4}
          >
            <option value="">Choose a snapshot from before the problem</option>
            {state?.snapshots.map((snapshot) => (
              <option key={snapshot.id} value={snapshot.id}>
                {new Date(snapshot.time).toLocaleString()} ·{" "}
                {snapshot.id.slice(0, 8)}
              </option>
            ))}
          </NativeSelect.Field>
          <NativeSelect.Indicator />
        </NativeSelect.Root>
        <Button disabled={!canPrepare} onClick={() => void request("prepare")}>
          Test restore into isolated database
        </Button>
      </Box>
      {job && (
        <Box
          borderWidth="1px"
          borderRadius="lg"
          p={5}
          mb={5}
          aria-live="polite"
        >
          <Heading size="sm">
            Recovery status: {job.phase.replaceAll("-", " ")}
          </Heading>
          <Text mt={3}>
            {job.phase === "resumed" && job.rolledBack
              ? "Staging has resumed on the pre-recovery database. The post-restore database remains retained separately."
              : descriptions[job.phase] ||
                "Check the worker status before advancing."}
          </Text>
          <Text color="fg.muted" mt={3}>
            Snapshot {job.snapshotId.slice(0, 8)}
            {job.snapshotTime &&
              ` · ${new Date(job.snapshotTime).toLocaleString()}`}
          </Text>
          {job.validation && (
            <Text mt={3}>
              {job.validation.tables} tables ·{" "}
              {job.validation.rows.toLocaleString()} rows · schema compatibility
              passed
            </Text>
          )}
          {job.dumpSha256 && (
            <Box as="details" mt={3}>
              <Box as="summary" cursor="pointer">
                Dump verification
              </Box>
              <Text fontSize="sm" overflowWrap="anywhere" mt={2}>
                SHA256: {job.dumpSha256}
              </Text>
            </Box>
          )}
          {job.phase === "resumed" && job.rolledBack && (
            <Text mt={3}>
              Rollback completed. A further recovery starts with a new snapshot
              validation.
            </Text>
          )}
        </Box>
      )}
      {next && (
        <Box borderWidth="1px" borderRadius="lg" p={5} mb={5}>
          <Heading size="sm" mb={3}>
            {next.action === "freeze" || next.action === "freeze-rollback"
              ? "2. Pause staging"
              : next.action === "resume"
                ? "4. Check and resume staging"
                : "3. Confirm the database switch"}
          </Heading>
          {next.action === "restore" && (
            <Text mb={4} fontWeight="medium">
              Staging will return to the selected backup. Changes made after
              that backup will leave the active database; its current data is
              preserved for rollback.
            </Text>
          )}
          {next.action === "rollback" && (
            <Text mb={4}>
              Rollback restores the database preserved before recovery. The
              current database will be retained separately.
            </Text>
          )}
          {next.action === "resume" && (
            <Box mb={4}>
              <label>
                <input
                  type="checkbox"
                  checked={reconciled}
                  onChange={(e) => setReconciled(e.target.checked)}
                />{" "}
                I have reconciled staging’s queued work and cached data before
                allowing background processing to resume.
              </label>
              <Text mt={2} color="fg.muted">
                Pausing and resuming uses the same application containers;
                migrations are not rerun.
              </Text>
            </Box>
          )}
          <Text mb={2}>
            Type <strong>{next.phrase}</strong> to confirm.
          </Text>
          <Input
            aria-label="Recovery confirmation"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            autoComplete="off"
            disabled={busy}
            mb={3}
          />
          <Button
            disabled={!canAdvance}
            onClick={() => void request(next.action, confirmation)}
          >
            {next.label}
          </Button>
        </Box>
      )}
      {job && ["validated", "failed"].includes(job.phase) && (
        <Box mb={5}>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  "Discard only this isolated test database? Current staging and encrypted backups stay intact.",
                )
              )
                void request(
                  "abort",
                  `DISCARD TEST RESTORE ${job.id.slice(0, 8)}`,
                );
            }}
          >
            Discard test restore
          </Button>
        </Box>
      )}
      <Flex align="center" gap={3}>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void request()}
        >
          Refresh recovery status
        </Button>
        {busy && (
          <>
            <Spinner size="sm" />
            <Text>Recovery request in progress…</Text>
          </>
        )}
      </Flex>
      {error && (
        <Box
          role="alert"
          borderWidth="1px"
          borderColor="red.500"
          borderRadius="md"
          p={4}
          mt={4}
        >
          {error}
        </Box>
      )}
      <Text mt={6} color="fg.muted" fontSize="sm">
        This workflow covers the staging database. Uploads and application
        secrets are outside this backup. Retained recovery databases require
        separate cleanup.
      </Text>
    </Box>
  );
};
