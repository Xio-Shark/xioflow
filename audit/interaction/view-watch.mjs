import fs from 'node:fs';
import path from 'node:path';
import { FileObservation, ObservationError, digest, wireBytes } from './observation.mjs';

const MODES = new Set(['agent-poll', 'server-poll', 'watch-view']);

/** Current-state notifications, not a reliable history of filesystem events. */
export class ObservedView {
  #file;
  #project;
  #mode;
  #watcher;
  #timer;
  #pending;
  #closed = false;
  #key;
  #latest;
  #messages = [];
  #metrics = { readAttempts: 0, successfulSourceBytes: 0, osHints: 0, ignoredFileHints: 0,
    suppressedHints: 0, reconciliations: 0, watchErrors: 0, notifications: 0, notificationBytes: 0 };

  constructor(file, project, { mode = 'watch-view', pollMs = 20, reconcileMs = 200,
    coalesceMs = 5, acceptHint = () => true } = {}) {
    if (!MODES.has(mode)) throw new Error(`Unknown observer mode: ${mode}`);
    for (const [name, value] of Object.entries({ pollMs, reconcileMs, coalesceMs })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    }
    if (typeof project !== 'function' || typeof acceptHint !== 'function') throw new TypeError('Expected projection and hint functions');
    this.#file = path.resolve(file);
    this.#project = project;
    this.#mode = mode;
    try {
      if (mode === 'watch-view') {
        // Watch the directory: an atomic replacement changes the file's inode.
        this.#watcher = fs.watch(path.dirname(this.#file), (_event, filename) => {
          if (this.#closed) return;
          this.#metrics.osHints += 1;
          if (filename !== null && filename !== undefined && filename.toString() !== path.basename(this.#file)) {
            this.#metrics.ignoredFileHints += 1;
            return;
          }
          if (!acceptHint()) {
            this.#metrics.suppressedHints += 1;
            return;
          }
          // First hint schedules a bounded delay; later hints do not postpone it.
          if (!this.#pending) this.#pending = setTimeout(() => {
            this.#pending = undefined;
            if (!this.#closed) this.#capture('event');
          }, coalesceMs);
        });
        this.#watcher.on('error', (error) => {
          if (this.#closed) return;
          this.#metrics.watchErrors += 1;
          this.#publish({ type: 'watch_error', code: error.code ?? 'watch_error', message: error.message,
            continuation: 'periodic_reconciliation' });
        });
      }
      // Installing the watcher first closes the subscribe-after-read race.
      this.#capture('initial');
      this.#timer = setInterval(() => this.#capture(mode === 'watch-view' ? 'reconcile' : 'poll'),
        mode === 'watch-view' ? reconcileMs : pollMs);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  #capture(cause) {
    if (this.#closed) return;
    this.#metrics.readAttempts += 1;
    if (cause === 'reconcile') this.#metrics.reconciliations += 1;
    let observation;
    let next;
    try {
      observation = new FileObservation(this.#file);
    } catch (error) {
      // Source failures are observable states; programming errors still fail hard.
      if (!(error instanceof ObservationError) && typeof error.code !== 'string') throw error;
      next = { status: 'unavailable', code: error.code, message: error.message };
    }
    if (observation) {
      this.#metrics.successfulSourceBytes += observation.describe().bytes;
      const view = this.#project(observation.full().records);
      const encoded = JSON.stringify(view);
      if (encoded === undefined) throw new TypeError('Projection must return JSON data');
      next = { status: 'ok', view: JSON.parse(encoded), viewVersion: digest(encoded), sourceVersion: observation.version };
    }
    const key = next.status === 'ok' ? `ok:${next.viewVersion}` : `unavailable:${next.code}`;
    this.#latest = next;
    if (this.#mode === 'agent-poll' || key !== this.#key) {
      this.#publish({ type: 'view', cause, ...next });
    }
    this.#key = key;
  }

  #publish(message) {
    const envelope = { sequence: this.#messages.length + 1, ...message };
    this.#messages.push(envelope);
    this.#metrics.notifications += 1;
    this.#metrics.notificationBytes += wireBytes(envelope);
  }

  get latest() { return structuredClone(this.#latest); }
  get messages() { return structuredClone(this.#messages); }
  get metrics() { return { ...this.#metrics, closed: this.#closed }; }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    clearTimeout(this.#pending);
    this.#watcher?.close();
    this.#watcher = undefined;
    this.#timer = undefined;
    this.#pending = undefined;
  }
}
