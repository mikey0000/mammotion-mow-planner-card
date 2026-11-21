import { css } from "lit";

/** Label on the inline-start side, current value on the inline-end side, as on Home Assistant's own sliders. */
export const headStyles = css`
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--ha-space-2, 8px);
    margin-block-end: var(--ha-space-1, 4px);
  }
  /* Dimmed, but a locked setting's current value must stay readable. */
  :host([disabled]) .head > * {
    color: var(--secondary-text-color, #727272);
  }
  /* Wraps rather than hiding the end of a long value, such as an angle relative to the optimal one. */
  .value {
    min-width: 0;
    font-weight: var(--ha-font-weight-medium, 500);
    text-align: end;
    overflow-wrap: break-word;
    unicode-bidi: plaintext;
  }
`;
