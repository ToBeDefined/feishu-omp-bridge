import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Scheduler } from './index';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scheduler-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function file(): string {
  return join(dir, 'scheduler.json');
}

describe('Scheduler', () => {
  it('adds and lists tasks', async () => {
    const s = new Scheduler(file());
    await s.load();
    const t = await s.add({ chatId: 'oc_1', prompt: 'run this', intervalMs: 60_000 });
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0]?.id).toBe(t.id);
    expect(s.list()[0]?.prompt).toBe('run this');
  });

  it('persists tasks across reload', async () => {
    const s1 = new Scheduler(file());
    await s1.load();
    await s1.add({ chatId: 'oc_1', prompt: 'persist me', intervalMs: 120_000 });

    const s2 = new Scheduler(file());
    await s2.load();
    expect(s2.list()).toHaveLength(1);
    expect(s2.list()[0]?.prompt).toBe('persist me');
  });

  it('removes tasks', async () => {
    const s = new Scheduler(file());
    await s.load();
    const t = await s.add({ chatId: 'oc_1', prompt: 'x', intervalMs: 1000 });
    expect(await s.remove(t.id)).toBe(true);
    expect(s.list()).toHaveLength(0);
    expect(await s.remove(t.id)).toBe(false);
  });

  it('fires due tasks and reschedules them', async () => {
    const s = new Scheduler(file());
    await s.load();
    const fired: string[] = [];
    s.setHandler((t) => fired.push(t.id));
    await s.add({ chatId: 'oc_1', prompt: 'x', intervalMs: 1000, delayMs: 0 });
    const task = s.list()[0]!;
    const first = task.nextRunAt;
    await s['tick'](); // fire due task
    const after = s.list()[0]!;
    expect(fired).toEqual([task.id]);
    expect(after.nextRunAt).toBeGreaterThan(first); // rescheduled
  });

  it('does not fire disabled tasks', async () => {
    const s = new Scheduler(file());
    await s.load();
    const fired: string[] = [];
    s.setHandler((t) => fired.push(t.id));
    const t = await s.add({ chatId: 'oc_1', prompt: 'x', intervalMs: 1000, delayMs: 0 });
    t.enabled = false;
    await s['tick']();
    expect(fired).toEqual([]);
  });
});

describe('Scheduler adversarial', () => {
  it('loads a corrupted file into an empty scheduler', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file(), '{not valid json');
    const s = new Scheduler(file());
    await s.load();
    expect(s.list()).toEqual([]);
  });

  it('does not re-fire a task on a second tick before its next run', async () => {
    const s = new Scheduler(file());
    await s.load();
    const fired: string[] = [];
    s.setHandler((t) => fired.push(t.id));
    const t = await s.add({ chatId: 'oc_1', prompt: 'x', intervalMs: 60_000, delayMs: 0 });
    await s['tick']();
    expect(fired).toEqual([t.id]);
    // 第二次 tick：nextRunAt 已推进，不再 fire
    await s['tick']();
    expect(fired).toEqual([t.id]);
  });

  it('a throwing handler does not break the scheduler or other tasks', async () => {
    const s = new Scheduler(file());
    await s.load();
    const fired: string[] = [];
    s.setHandler((t) => {
      if (t.prompt === 'boom') throw new Error('handler failed');
      fired.push(t.id);
    });
    await s.add({ chatId: 'oc_1', prompt: 'boom', intervalMs: 60_000, delayMs: 0 });
    const ok = await s.add({ chatId: 'oc_2', prompt: 'fine', intervalMs: 60_000, delayMs: 0 });
    await s['tick']();
    expect(fired).toEqual([ok.id]);
  });

});
