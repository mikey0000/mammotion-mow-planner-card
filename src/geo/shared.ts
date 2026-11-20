import type { PathD } from "clipper2-ts";
import type { Ring } from "../model";

export const RAD = Math.PI / 180;

export const toPath = (ring: Ring): PathD => ring.map(({ x, y }) => ({ x, y }));
