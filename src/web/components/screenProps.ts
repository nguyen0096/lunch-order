import type { Me, Org, Role } from "../../shared/types.js";

/** Every screen is handed the same three things, so App never special-cases one. */
export type ScreenProps = { me: Me; org: Org; role: Role };
