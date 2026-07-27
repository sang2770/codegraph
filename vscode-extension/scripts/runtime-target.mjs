export const SUPPORTED_TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
];

export function normalizeTarget(platform = process.platform, arch = process.arch) {
  const normalizedArch = arch === 'x64' || arch === 'arm64' ? arch : null;
  const normalizedPlatform =
    platform === 'darwin' || platform === 'linux' || platform === 'win32'
      ? platform
      : null;

  if (!normalizedPlatform || !normalizedArch) {
    throw new Error(`Unsupported CodeBrain runtime target: ${platform}-${arch}`);
  }

  return `${normalizedPlatform}-${normalizedArch}`;
}

export function assertTarget(target) {
  if (!SUPPORTED_TARGETS.includes(target)) {
    throw new Error(
      `Unsupported target "${target}". Expected one of: ${SUPPORTED_TARGETS.join(', ')}`,
    );
  }
  return target;
}
