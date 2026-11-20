/** Registers an element unless the tag is taken, so loading the bundle twice is harmless. */
export function defineOnce(tag: string, element: CustomElementConstructor): void {
  if (!customElements.get(tag)) customElements.define(tag, element);
}
