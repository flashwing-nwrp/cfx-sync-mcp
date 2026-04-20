import type { z } from "zod";
import type { ResolveMappingEntryInput, ResolveMappingEntryOutput } from "../schemas/index.js";

export async function cfx_resolve_mapping_entry(
  _input: z.infer<typeof ResolveMappingEntryInput>
): Promise<z.infer<typeof ResolveMappingEntryOutput>> {
  throw new Error("cfx_resolve_mapping_entry: not implemented");
}
