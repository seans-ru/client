// Единственный владелец изображения: главное окно либо системный PiP.
let active = false;
let returnHandler: (() => void) | null = null;
const listeners = new Set<() => void>();

export const pipPresentation = {
  isActive: () => active,
  subscribe(callback: () => void) {
    listeners.add(callback);
    return () => { listeners.delete(callback); };
  },
  setActive(next: boolean) {
    if (active === next) return;
    active = next;
    listeners.forEach(callback => callback());
  },
  registerReturn(handler: () => void) {
    returnHandler = handler;
    return () => { if (returnHandler === handler) returnHandler = null; };
  },
  returnToMain() { returnHandler?.(); },
};
