import "dotenv/config";
import { addContentIdea } from "./core/ContentIdeas.js";

/**
 * Queue an idea/instruction for a future LinkedIn draft (used by the
 * Mon/Wed/Fri scheduled run, oldest idea first). For an idea you want drafted
 * right now instead, use src/draft-linkedin-post.js directly.
 *
 *   node src/add-content-idea.js "talk about the Cafi menu sync bug and how I fixed it"
 */
const idea = process.argv.slice(2).join(" ").trim();

if (!idea) {
  console.error('Usage: node src/add-content-idea.js "your idea or instruction here"');
  process.exit(1);
}

const id = await addContentIdea(idea);
console.log(`✅ Idea queued (id: ${id}).`);
console.log(`   It'll be used by the next LinkedIn draft that isn't given a more specific idea of its own.`);

process.exit(0);
