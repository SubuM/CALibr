import type { FastifyRequest } from "fastify";

/** Read the `file` field of a multipart upload into a Buffer. */
export async function getUploadedFile(req: FastifyRequest): Promise<Buffer> {
  const request = req as FastifyRequest & {
    files?: () => AsyncGenerator<{ fieldname?: string; toBuffer: () => Promise<Buffer> }>;
    file?: () => Promise<{ fieldname?: string; toBuffer: () => Promise<Buffer> }>;
  };
  if (typeof request.file === "function") {
    const part = await request.file();
    if (!part) throw new Error("missing file upload");
    return await part.toBuffer();
  }
  throw new Error("file uploads not enabled (install @fastify/multipart)");
}