import { describe, expect, it } from 'vitest';
import {
  checkJobTransition,
  isJobStatus,
  JOB_STATUSES,
  nextJobStatuses,
  type JobStatus,
} from './job-status.js';

const allowed: Array<[JobStatus, JobStatus]> = [
  ['new', 'quoted'],
  ['new', 'scheduled'],
  ['new', 'in_progress'],
  ['new', 'cancelled'],
  ['quoted', 'scheduled'],
  ['quoted', 'in_progress'],
  ['quoted', 'cancelled'],
  ['scheduled', 'in_progress'],
  ['scheduled', 'cancelled'],
  ['in_progress', 'completed'],
  ['in_progress', 'cancelled'],
];
const reopens: Array<[JobStatus, JobStatus]> = [
  ['completed', 'in_progress'],
  ['cancelled', 'new'],
];

describe('job status transitions', () => {
  it('allows exactly the forward transitions in the table', () => {
    for (const from of JOB_STATUSES) {
      for (const to of JOB_STATUSES) {
        const result = checkJobTransition(from, to, { reopen: true });
        const expected =
          allowed.some(([a, b]) => a === from && b === to) ||
          reopens.some(([a, b]) => a === from && b === to);
        expect(result.allowed, `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it('rejects skipping, reversing and leaving closed jobs', () => {
    for (const [from, to] of [
      ['new', 'completed'],
      ['quoted', 'new'],
      ['scheduled', 'quoted'],
      ['in_progress', 'new'],
      ['completed', 'cancelled'],
      ['completed', 'new'],
      ['cancelled', 'completed'],
    ] as Array<[JobStatus, JobStatus]>) {
      const result = checkJobTransition(from, to, { reopen: true });
      expect(result, `${from} -> ${to}`).toMatchObject({
        allowed: false,
        code: 'INVALID_TRANSITION',
      });
    }
  });

  it('requires an explicit reopen for closed jobs', () => {
    for (const [from, to] of reopens) {
      expect(checkJobTransition(from, to)).toMatchObject({
        allowed: false,
        code: 'REOPEN_REQUIRED',
      });
      expect(checkJobTransition(from, to, { reopen: true })).toMatchObject({
        allowed: true,
        reopen: true,
      });
    }
    expect(checkJobTransition('completed', 'in_progress', { reopen: true })).toMatchObject({
      clearsCompletedAt: true,
      setsCompletedAt: false,
    });
  });

  it('marks completion and reports unchanged status', () => {
    expect(checkJobTransition('in_progress', 'completed')).toEqual({
      allowed: true,
      reopen: false,
      setsCompletedAt: true,
      clearsCompletedAt: false,
    });
    expect(checkJobTransition('new', 'new')).toMatchObject({ allowed: false, code: 'UNCHANGED' });
  });

  it('lists next states for the UI, reopen last', () => {
    expect(nextJobStatuses('new').map((t) => t.status)).toEqual([
      'quoted',
      'scheduled',
      'in_progress',
      'cancelled',
    ]);
    expect(nextJobStatuses('completed')).toEqual([{ status: 'in_progress', reopen: true }]);
    expect(nextJobStatuses('cancelled')).toEqual([{ status: 'new', reopen: true }]);
    expect(isJobStatus('in_progress')).toBe(true);
    expect(isJobStatus('teleported')).toBe(false);
  });
});
