import { put } from "@vercel/blob";
import { z } from "zod";
import { GoogleAIFileManager, FileState } from "@google/generative-ai/server";
import { writeFile, readFile, open, mkdir, unlink } from "fs/promises";
import { join } from "path";
import os from "os";

import { auth } from "@/app/(auth)/auth";

// Use Blob instead of File since File is not available in Node.js environment
const FileSchema = z.object({
  file: z
    .instanceof(Blob)
    .refine((file) => file.size <= 50 * 1024 * 1024, {
      // increased to 50MB for videos
      message: "File size should be less than 50MB",
    })
    // Update the file type based on the kind of files you want to accept
    .refine(
      (file) => ["image/jpeg", "image/png", "video/mp4"].includes(file.type),
      {
        message: "File type should be JPEG, PNG, or MP4",
      }
    ),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentType = request.headers.get("content-type") || "";
  const contentRange = request.headers.get("content-range");
  const fileName = request.headers.get("x-file-name");

  // Handle chunked video upload
  if (contentType === "video/mp4" && contentRange && fileName) {
    try {
      const [, start, end, total] =
        contentRange.match(/bytes (\d+)-(\d+)\/(\d+)/) || [];
      const chunk = await request.arrayBuffer();

      // Create temp directory if it doesn't exist
      const tempDir = join(os.tmpdir(), "video-uploads");
      await mkdir(tempDir, { recursive: true });

      // Use fileName for the temp file
      const tempPath = join(tempDir, fileName);

      // Append chunk to file
      const fd = await open(tempPath, "a+");
      await fd.write(Buffer.from(chunk), 0, chunk.byteLength, parseInt(start));
      await fd.close();

      // If this is the last chunk, process the complete file
      if (parseInt(end) + 1 === parseInt(total)) {
        console.log("uploading complete file to vercel blob");
        const fileBuffer = await readFile(tempPath);
        const blobData = await put(fileName, fileBuffer, {
          access: "public",
        });

        console.log("processing with gemini");
        const fileManager = new GoogleAIFileManager(
          process.env.GOOGLE_API_KEY!
        );

        console.log("uploading to gemini");
        const uploadResponse = await fileManager.uploadFile(tempPath, {
          mimeType: "video/mp4",
          displayName: fileName,
        });

        // Wait for file to be active
        let geminiFile = await fileManager.getFile(uploadResponse.file.name);
        let attempts = 0;
        const maxAttempts = 10;

        while (
          geminiFile.state !== FileState.ACTIVE &&
          attempts < maxAttempts
        ) {
          console.log(`waiting for file to be active, attempt ${attempts + 1}`);
          await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds
          geminiFile = await fileManager.getFile(uploadResponse.file.name);
          attempts++;
        }

        if (geminiFile.state !== FileState.ACTIVE) {
          throw new Error(
            "File failed to become active after multiple attempts"
          );
        }

        // Clean up temp file
        await unlink(tempPath);

        return Response.json({
          ...blobData,
          geminiUri: geminiFile.uri,
        });
      }

      // Return progress for non-final chunks
      return Response.json({
        status: "chunk-received",
        progress: Math.round((parseInt(end) / parseInt(total)) * 100),
      });
    } catch (error) {
      console.error("Chunked upload error:", error);
      return Response.json(
        {
          error: error instanceof Error ? error.message : "Upload failed",
        },
        { status: 500 }
      );
    }
  }

  // Handle regular form uploads (existing code)
  try {
    console.log("parsing form data");
    const formData = await request.formData();
    const file = formData.get("file") as Blob;

    if (!file) {
      console.log("no file found in form data");
      return Response.json({ error: "No file uploaded" }, { status: 400 });
    }

    console.log(`validating file: ${(file as any).name}`);
    const validatedFile = FileSchema.safeParse({ file });

    if (!validatedFile.success) {
      const errorMessage = validatedFile.error.errors
        .map((error) => error.message)
        .join(", ");
      console.log(`file validation failed: ${errorMessage}`);
      return Response.json({ error: errorMessage }, { status: 400 });
    }

    const filename = (formData.get("file") as File).name;
    console.log(`processing file: ${filename}, type: ${file.type}`);
    const fileBuffer = await file.arrayBuffer();

    try {
      console.log("uploading to vercel blob");
      const blobData = await put(`${filename}`, fileBuffer, {
        access: "public",
      });
      console.log(`blob upload successful: ${blobData.url}`);

      if (file.type === "video/mp4") {
        console.log("processing mp4 with gemini");
        const fileManager = new GoogleAIFileManager(
          process.env.GOOGLE_API_KEY!
        );

        // Create temp file
        const tempPath = join(os.tmpdir(), filename);
        await writeFile(tempPath, Buffer.from(fileBuffer));

        console.log("uploading to gemini");
        const uploadResponse = await fileManager.uploadFile(tempPath, {
          mimeType: "video/mp4",
          displayName: filename,
        });
        console.log("gemini upload complete, waiting for processing");

        let geminiFile = await fileManager.getFile(uploadResponse.file.name);
        while (geminiFile.state === FileState.PROCESSING) {
          console.log("gemini still processing, waiting...");
          await new Promise((resolve) => setTimeout(resolve, 2000));
          geminiFile = await fileManager.getFile(uploadResponse.file.name);
        }

        if (geminiFile.state === FileState.FAILED) {
          console.log("gemini processing failed");
          return Response.json(
            { error: "Video processing failed" },
            { status: 500 }
          );
        }

        console.log("gemini processing complete", geminiFile);
        return Response.json({
          ...blobData,
          // url: geminiFile.uri, // overriding vercel blob url with gemini uri
          geminiUri: geminiFile.uri,
        });
      }

      console.log("image upload complete");
      return Response.json(blobData);
    } catch (error) {
      console.log("upload error:", error);
      return Response.json({ error: "Upload failed" }, { status: 500 });
    }
  } catch (error) {
    console.log("request processing error:", error);
    return Response.json(
      { error: "Failed to process request" },
      { status: 500 }
    );
  }
}
