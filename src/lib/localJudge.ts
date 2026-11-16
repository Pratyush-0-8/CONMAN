
import { pipeline } from "@huggingface/transformers";

const MODEL =
  "Xenova/DeBERTa-v3-xsmall-mnli-fever-anli-ling-binary";

// Load the model once and reuse it.
let modelPromise: ReturnType<typeof pipeline> | null = null;

function loadModel() {
  if (!modelPromise) {
    modelPromise = pipeline("zero-shot-classification", MODEL, {
      device: "wasm",
      dtype: "q8",
    });
  }

  return modelPromise;
}

export async function judgeAnswer(
  question: string,
  answer: string
): Promise<number> {
  const start = performance.now();

  const model = await loadModel();

  // Describe what a good vs. bad answer looks like.
  const labels = [
    "an insightful, logically justified, creative, and relevant answer",
    "an irrelevant, superficial, contradictory, or poorly reasoned answer",
    ];

  const result = await model(
    `Question: ${question}\nAnswer: ${answer}`,
    labels,
    {
      hypothesis_template: "The player's response is {}.",
    }
  );

  console.log("XtremeDistil raw result:", result);

  const goodIndex = result.labels.indexOf(labels[0]);

  if (goodIndex === -1) {
    throw new Error("Good-answer label missing");
  }

  const probability = result.scores[goodIndex];

  // Experimental conversion to a score out of 50.
  const score = Math.round(probability * 50);

  console.log("Score:", score);
  console.log(
    "Time:",
    ((performance.now() - start) / 1000).toFixed(2),
    "seconds"
  );

  return score;
}
