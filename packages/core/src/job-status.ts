/**
 * Deterministic job lifecycle. The API asks this module whether a status change is allowed;
 * nothing else decides it. Reopening a completed or cancelled job is allowed only when the
 * caller says so explicitly, so a stray status update cannot quietly revive closed work.
 */
export const JOB_STATUSES = [
  'new',
  'quoted',
  'scheduled',
  'in_progress',
  'completed',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

const FORWARD: Record<JobStatus, readonly JobStatus[]> = {
  new: ['quoted', 'scheduled', 'in_progress', 'cancelled'],
  quoted: ['scheduled', 'in_progress', 'cancelled'],
  scheduled: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

/** Reopen targets for closed jobs. */
const REOPEN: Partial<Record<JobStatus, JobStatus>> = {
  completed: 'in_progress',
  cancelled: 'new',
};

export interface JobTransition {
  status: JobStatus;
  /** True when this move reopens a closed job and needs an explicit reopen request. */
  reopen: boolean;
}

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (JOB_STATUSES as readonly string[]).includes(value);
}

export function isClosedJobStatus(status: JobStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

/** Every status a job may move to next, in display order. */
export function nextJobStatuses(from: JobStatus): JobTransition[] {
  const forward = FORWARD[from].map((status) => ({ status, reopen: false }));
  const reopen = REOPEN[from];
  return reopen ? [...forward, { status: reopen, reopen: true }] : forward;
}

export type TransitionCheck =
  | { allowed: true; reopen: boolean; setsCompletedAt: boolean; clearsCompletedAt: boolean }
  | {
      allowed: false;
      code: 'UNCHANGED' | 'INVALID_TRANSITION' | 'REOPEN_REQUIRED';
      message: string;
    };

const label = (status: JobStatus) => status.replace('_', ' ');

export function checkJobTransition(
  from: JobStatus,
  to: JobStatus,
  options: { reopen?: boolean } = {},
): TransitionCheck {
  if (from === to)
    return { allowed: false, code: 'UNCHANGED', message: `The job is already ${label(to)}.` };
  const match = nextJobStatuses(from).find((transition) => transition.status === to);
  if (!match)
    return {
      allowed: false,
      code: 'INVALID_TRANSITION',
      message: `A ${label(from)} job cannot move to ${label(to)}.`,
    };
  if (match.reopen && !options.reopen)
    return {
      allowed: false,
      code: 'REOPEN_REQUIRED',
      message: `This job is ${label(from)}. Reopen it explicitly to move it to ${label(to)}.`,
    };
  return {
    allowed: true,
    reopen: match.reopen,
    setsCompletedAt: to === 'completed',
    clearsCompletedAt: from === 'completed',
  };
}
