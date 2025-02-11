import { put } from "@vercel/blob";
import { z } from "zod";
import { GoogleAIFileManager, FileState } from "@google/generative-ai/server";
import { writeFile } from "fs/promises";
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
  console.log("starting file upload request");
  const session = await auth();

  if (!session) {
    console.log("unauthorized request detected");
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (request.body === null) {
    console.log("empty request body detected");
    return new Response("Request body is empty", { status: 400 });
  }

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
