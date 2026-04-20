import type { z } from "zod";
import type { ListUnresolvedInput, ListUnresolvedOutput } from "../schemas/index.js";

export async function cfx_list_unresolved(
  _input: z.infer<typeof ListUnresolvedInput>
): Promise<z.infer<typeof ListUnresolvedOutput>> {
  throw new Error("cfx_list_unresolved: not implemented");
}
