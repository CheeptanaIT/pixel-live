import { levels } from "../audio/levels";
import { emoteBus } from "./emotes";
import type { StageSource } from "./StageRenderer";

/**
 * Feeds the stage with who is speaking right now. One module-level object, so its identity is
 * stable: handing StageView a fresh object would rebuild the whole renderer.
 */
export const levelsSource: StageSource = {
  isSpeaking: (id) => levels.isSpeaking(id),
  tick: (now) => levels.tick(now),
  onEmote: (listener) => emoteBus.subscribe(listener),
};
