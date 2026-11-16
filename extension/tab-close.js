/** Confirm each requested removal; an unrelated API error is not proof that a tab closed. */
export async function closeAndConfirmTab(api, id) {
  try {
    await api.tabs.remove(id);
  } catch {
    return { closed: false, reason: 'Chrome could not close this tab. Review it and try again.' };
  }
  try {
    await api.tabs.get(id);
    return { closed: false, reason: 'This tab remained open; the page may have canceled closing.' };
  } catch (error) {
    const absent = new RegExp(`^(?:No tab with id: ${id}\\.?|Invalid tab ID: ${id}\\.?)$`, 'i').test(error?.message || '');
    return absent ? { closed: true } : { closed: false, reason: 'Chrome did not confirm whether this tab closed. Refresh the list.' };
  }
}
