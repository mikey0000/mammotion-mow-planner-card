# Mammotion Mow Planner Card

A Home Assistant dashboard card for the [Mammotion integration](https://github.com/mikey0000/Mammotion-HA). Pick the areas to mow on the map, set the pattern, and see what the mow will look like before you start it.

- **Areas.** Tap areas on the map or in the list. They are mowed in the order you tap them.
- **Pattern.** Change the path angle, pattern, path spacing, perimeter laps and no-go zone laps, and watch the stripes redraw on the map as you drag.
- **Review.** Check the summary, the path length and the estimated time, then start the job.

The card reads the map and your current settings from the integration. It only sends something to the mower when you confirm **Start now**. Changing a setting in the card does not change the integration's entities; the values travel with the start command.

## Requirements

- Home Assistant 2024.8 or newer.
- The Mammotion integration, with at least one mower that has a map.

## Install

### HACS

1. HACS → ⋮ → **Custom repositories** → add this repository with type **Dashboard**.
2. Install **Mammotion Mow Planner Card**.
3. Reload the browser.

### Manual

1. Download `mammotion-mow-planner-card.js` from the latest release (or build it, see below).
2. Copy it to `config/www/`.
3. Settings → Dashboards → ⋮ → **Resources** → add `/local/mammotion-mow-planner-card.js` as a JavaScript module.

## Use

Add the **Mammotion Mow Planner** card from the card picker, or in YAML:

```yaml
type: custom:mammotion-mow-planner-card
```

| Option         | Type    | Default        | Description                                                                             |
| -------------- | ------- | -------------- | --------------------------------------------------------------------------------------- |
| `entities`     | list    | all mowers     | `lawn_mower` entities to offer. With more than one, the card shows a mower picker.      |
| `title`        | string  | the mower name | Heading of the card.                                                                    |
| `angle_offset` | number  | `0`            | Degrees added to custom path angles in the preview. See [Path angle](#path-angle).      |
| `exact_route`  | boolean | `false`        | Offer **Get route from mower** in the review step. Experimental, see [Limits](#limits). |

The card works best at half a dashboard width or more. On a wide card the map sits beside the settings; on a phone it stays pinned above them while you scroll.

## How the preview is drawn

The preview is computed in the browser from the map and your settings. It is a faithful sketch, not the mower's own plan.

- **Path spacing** is drawn to scale. When passes would be too close together to tell apart on screen, the map draws every n-th pass; zoom in to see them all.
- **Perimeter laps** are rings inside the boundary, one path spacing apart. **No-go zone laps** are rings around each no-go zone.
- **Grid** adds a second pass at the crossing angle. **Adaptive** is drawn as plain stripes, because the mower splits the area into zones itself. **Perimeter** has no stripes.
- The estimated time is path length divided by speed. It ignores turns, travel between areas and charging, so expect the real job to take longer.

### Path angle

- **Custom** uses your angle as a fixed direction on the map: 0° runs east–west, 90° north–south.
- **Optimal** lets the mower choose the efficient direction, and your angle shifts it. The card guesses that direction from the long side of each area and marks the preview as approximate.
- **Random** changes direction every job. The card shows one example.

The mower measures custom angles in its own map frame, which can be rotated from true north. If the stripes on your lawn end up turned compared with the preview, set `angle_offset` to the difference.

## Limits

- The preview cannot show the route the mower will actually take. `exact_route: true` adds a button that asks the mower to plan the job without starting and then fetches that route. It depends on integration behaviour that is not reliable yet, so it may report that the mower shared no route.
- Obstacle detection mode, start progress and the Yuka collection settings are not in the card. The job uses the values of the integration's own entities for those.
- Starting a job while the mower is mowing, paused or returning ends the current job first. The card warns you in the review step.
- Loading the map makes the integration start a five-minute status stream from the mower. The card loads the map once per mower and when you press refresh.

## Development

```sh
npm ci
npm run demo    # http://localhost:5173/demo/ with a mock Home Assistant
npm run check   # typecheck, lint, tests and build
```

The demo page runs the card against made-up mowers. Service calls are listed under the card and never leave the page. Add `?dark`, `?lang=de`, `?lang=he` (right-to-left), `?single`, `?map=empty` or `?map=error` to the URL to try other states.

`npm run build` writes `dist/mammotion-mow-planner-card.js`. Pushing a `v*` tag builds it and attaches it to the GitHub release, which is what HACS installs.

| Dependency         | Why                                                       |
| ------------------ | --------------------------------------------------------- |
| `lit`              | The element base Home Assistant itself uses.              |
| `clipper2-ts`      | Polygon offsetting and clipping for the laps and stripes. |
| `@panzoom/panzoom` | Drag, wheel and pinch on the map.                         |
| `@mdi/js`          | Icon paths; only the icons used are bundled.              |
