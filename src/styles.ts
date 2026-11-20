import { css } from "lit";

/** Look shared by every control in the card, matching Home Assistant tile features. */
export const controlStyles = css`
  :host {
    --mmp-control-height: 42px;
    --mmp-radius: var(--ha-border-radius-lg, 12px);
    --mmp-accent: var(--primary-color, #03a9f4);
    --mmp-surface: color-mix(in srgb, var(--primary-text-color, #212121) 6%, transparent);
    --mmp-tint: color-mix(in srgb, var(--mmp-accent) 20%, transparent);
    color: var(--primary-text-color, #212121);
    font-family: var(--ha-font-family-body, Roboto, Noto, sans-serif);
    font-size: var(--ha-font-size-m, 14px);
  }
  button {
    font: inherit;
    color: inherit;
    cursor: pointer;
    border: none;
    background: none;
    padding: 0;
    -webkit-tap-highlight-color: transparent;
  }
  button:disabled {
    cursor: default;
    color: var(--disabled-text-color, #9e9e9e);
  }
  :is(button, input, select, summary, [tabindex]):focus-visible {
    outline: 2px solid var(--mmp-accent);
    outline-offset: 2px;
  }
  .icon {
    width: 24px;
    height: 24px;
    fill: currentColor;
    flex: none;
  }
  .secondary {
    color: var(--secondary-text-color, #727272);
    font-size: var(--ha-font-size-s, 12px);
  }
  @media (prefers-reduced-motion: reduce) {
    * {
      transition: none !important;
      animation: none !important;
    }
  }
`;
