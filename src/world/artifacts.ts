import { createHash } from 'node:crypto';
import type { WorldArtifact, WorldRef } from './contract.js';
import type { openWorldState } from './state.js';

/** Missing evidence is unknown; supplied but inconsistent evidence is an error. */
export function verifyWorldArtifactBody(artifact: WorldArtifact): boolean {
  if (artifact.body === undefined) return artifact.kind === 'file';
  if (typeof artifact.body !== 'string') throw new Error('Invalid artifact body');
  const hash = createHash('sha256').update(artifact.body, 'utf8').digest('hex');
  if (hash !== artifact.hash) throw new Error('Artifact body hash mismatch');
  return true;
}

/** Read the exact prepared historical event, never rerun the model or advance history. */
export function readWorldArtifacts(world: Awaited<ReturnType<typeof openWorldState>>,
  ref: WorldRef): readonly WorldArtifact[] {
  if (world.domain.isClosed()) throw new Error('World is closed');
  if (ref.worldId !== world.state.worldId) throw new Error('Artifact world mismatch');
  const event = world.domain.getStore().getJournalEvent(world.domain.domainId, ref.atSeq);
  if (!event || !['WORLD_STEP_PREPARED', 'WORLD_STEP_UNKNOWN'].includes(event.type)
      || event.payload.worldId !== ref.worldId || event.payload.id !== ref.id) {
    throw new Error('Artifact history reference mismatch');
  }
  const artifacts = event.payload.artifacts as WorldArtifact[];
  if (!Array.isArray(artifacts)) throw new Error('Invalid saved artifacts');
  for (const artifact of artifacts) {
    if (!verifyWorldArtifactBody(artifact)) throw new Error('Artifact body missing');
  }
  return artifacts;
}
