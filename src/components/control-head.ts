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
  :host([disabled]) .head > * {
    color: var(--disabled-text-color, #9e9e9e);
  }
  .value {
    font-weight: var(--ha-font-weight-medium, 500);
    white-space: nowrap;
    unicode-bidi: plaintext;
    overflow: hidden;
    text-overflow: ellipsis;
  }
`;
