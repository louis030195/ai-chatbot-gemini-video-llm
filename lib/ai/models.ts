import { openai } from "@ai-sdk/openai";
import { fireworks } from "@ai-sdk/fireworks";
import {
  customProvider,
  extractReasoningMiddleware,
  wrapLanguageModel,
} from "ai";
import { GoogleGenerativeAI } from "@google/generative-ai";

export const DEFAULT_CHAT_MODEL: string = "chat-model-small";

export const myProvider = customProvider({
  languageModels: {
    "chat-model-small": openai("gpt-4o-mini"),
    "chat-model-large": openai("gpt-4o"),
    "chat-model-reasoning": wrapLanguageModel({
      model: fireworks("accounts/fireworks/models/deepseek-r1"),
      middleware: extractReasoningMiddleware({ tagName: "think" }),
    }),
    "title-model": openai("gpt-4-turbo"),
    "block-model": openai("gpt-4o-mini"),
    "video-model": {
      specificationVersion: "v1",
      provider: "google",
      modelId: "gemini-2.0-flash-exp",
      defaultObjectGenerationMode: "json",
      async doGenerate(options) {
        throw new Error("Not implemented");
      },
      async doStream(options) {
        const prompt = options.prompt;
        const geminiVideoInput = options.providerMetadata?.google
          ?.experimental_geminiUri as string | undefined;

        console.log(
          "options",
          JSON.stringify(
            options.prompt,
            (key, value) => (key === "data" ? undefined : value),
            2
          )
        );
        // log options but exclude the .prompt
        console.log(
          "options",
          JSON.stringify(
            options,
            (key, value) => (key === "prompt" ? undefined : value),
            2
          )
        );

        const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!);
        const model = genAI.getGenerativeModel({
          model: "gemini-2.0-flash-exp",
        });

        // construct generation input array: include gemini video input if available
        const generationInput: Array<{
          fileData?: { mimeType: string; fileUri: string };
          text?: string;
        }> = [];
        if (geminiVideoInput) {
          generationInput.push({
            fileData: {
              mimeType: "video/mp4",
              fileUri: geminiVideoInput,
            },
          });
        }

        // filter out base64 shit from prompt (eg. .data property of attachments)
        const p = JSON.stringify(
          options.prompt,
          (key, value) => (key === "data" ? undefined : value),
          2
        );

        generationInput.push({
          text: p,
        });

        // @ts-ignore
        const result = await model.generateContentStream(generationInput);

        // Set default usage info and provider metadata. Replace these placeholders if real data is available.
        const finishReason = "stop";
        const usage = { promptTokens: 0, completionTokens: 0 };
        const providerMetadata = {
          google: {
            groundingMetadata: null,
            safetyRatings: null,
          },
        };

        const stream = new ReadableStream({
          async start(controller) {
            // iterate through the async generator from the Gemini API
            for await (const chunk of result.stream) {
              const chunkText = chunk.text();
              if (chunkText) {
                // emit each chunk as a 'text-delta' type, which is expected by the consumer.
                controller.enqueue({
                  type: "text-delta",
                  textDelta: chunkText,
                });
              }
            }
            // finalize the stream with a 'finish' chunk that includes finishReason, usage, and providerMetadata.
            controller.enqueue({
              type: "finish",
              finishReason,
              usage,
              providerMetadata,
            });
            controller.close();
          },
        });

        return {
          stream,
          rawCall: {
            rawPrompt: prompt,
            rawSettings: {},
          },
        };
      },
    },
  },
  imageModels: {
    "small-model": openai.image("dall-e-3"),
  },
});

interface ChatModel {
  id: string;
  name: string;
  description: string;
}

export const chatModels: Array<ChatModel> = [
  // {
  //   id: "chat-model-small",
  //   name: "Small model",
  //   description: "Small model for fast, lightweight tasks",
  // },
  // {
  //   id: "chat-model-large",
  //   name: "Large model",
  //   description: "Large model for complex, multi-step tasks",
  // },
  // {
  //   id: "chat-model-reasoning",
  //   name: "Reasoning model",
  //   description: "Uses advanced reasoning",
  // },
  {
    id: "video-model",
    name: "Video analysis model",
    description: "Specialized model for analyzing video content",
  },
];
