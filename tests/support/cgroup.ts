import { CgroupPlatformDriver } from '@xioflow/kernel';

/**
 * cgroup 测试的前提：Linux、cgroup v2、宿主所在 cgroup 已委派（如 `systemd-run --scope -p Delegate=yes`）。
 * 不满足时测试以带原因的名字跳过；设置 XIOFLOW_EXPECT_CGROUP=1 时跳过变成失败，CI 用它防止静默跳过。
 */
export const cgroupUnavailable = CgroupPlatformDriver.unavailableReason();

if (cgroupUnavailable && process.env.XIOFLOW_EXPECT_CGROUP) {
  throw new Error(`XIOFLOW_EXPECT_CGROUP is set but the cgroup driver is unavailable: ${cgroupUnavailable}`);
}

export const cgroupSuiteName = (name: string) => (cgroupUnavailable ? `${name} (skipped: ${cgroupUnavailable})` : name);
