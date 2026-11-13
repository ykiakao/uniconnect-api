type Device = {
  tenantId: string;
  userId: string;
  token: string;
};

const devices = new Map<string, Device>();

export function registerPushDevice(
  tenantId: string,
  userId: string,
  token: string,
): void {
  for (const [key, device] of devices) {
    if (device.token === token) devices.delete(key);
  }

  devices.set(token, { tenantId, userId, token });
}

export function getPushTokens(
  tenantId: string,
  userIds: string[],
): string[] {
  const allowed = new Set(userIds);

  return [...devices.values()]
    .filter((device) =>
      device.tenantId === tenantId &&
      allowed.has(device.userId),
    )
    .map((device) => device.token);
}

export function unregisterPushDevice(
  tenantId: string,
  userId: string,
  token: string,
): void {
  const device = devices.get(token);

  if (device?.tenantId === tenantId && device.userId === userId) {
    devices.delete(token);
  }
}
