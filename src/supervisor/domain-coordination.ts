import type { ExecutionDomain } from '../domain.js';
import type { GitShadowSnapshotDriver } from '../snapshot/git-shadow.js';
import type { WorkspaceTransactions } from '../workspace/transactions.js';
import { ReadTracker } from './read-evidence.js';
import type { ActiveOperationState } from './types.js';

interface DomainCoordination {
  activeOperations: Map<string, ActiveOperationState>;
  materializedWorkspaces: Map<string, string>;
  readTracker: ReadTracker;
  workspaceTransactions?: {
    snapshotDriver: GitShadowSnapshotDriver;
    manager: WorkspaceTransactions;
  };
}

// 监督器是同一域的多个入口；在飞事实与访问时间观测必须由域统一协调。
// 按对象而非路径共享，避免已关闭域的现场泄漏到重新获取的域。
const coordinators = new WeakMap<ExecutionDomain, DomainCoordination>();

export function domainCoordination(domain: ExecutionDomain): DomainCoordination {
  let coordinator = coordinators.get(domain);
  if (!coordinator) {
    coordinator = { activeOperations: new Map(), materializedWorkspaces: new Map(), readTracker: new ReadTracker() };
    coordinators.set(domain, coordinator);
  }
  return coordinator;
}
