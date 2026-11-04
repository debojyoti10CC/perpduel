export async function roomInvite(code: string, funded: boolean): Promise<string> {
  let origin = location.origin;
  if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
    const response = await fetch('/api/invite-origin', { signal: AbortSignal.timeout(2000) }).catch(() => null);
    const data = response?.ok ? await response.json().catch(() => null) : null;
    if (data?.origin) origin = data.origin;
  }
  const link = new URL(funded ? '/' : '/arena', origin);
  link.searchParams.set('room', code);
  return link.href;
}

export async function copyInviteText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The Clipboard API can be unavailable over a local network's HTTP address.
    const field = document.createElement('textarea');
    field.value = text;
    field.readOnly = true;
    field.style.cssText = 'position:fixed;left:-9999px';
    const focused = document.activeElement;
    document.body.append(field);
    try {
      field.select();
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      field.remove();
      if (focused instanceof HTMLElement) focused.focus();
    }
  }
}
