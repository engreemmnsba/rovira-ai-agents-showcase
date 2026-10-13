/**
 * Base class every worker agent extends. It only carries identity and a
 * schedule — MasterAgent owns running it safely, timing it, and logging it.
 */
export default class Agent {
  constructor({ id, name, cronSchedule }) {
    if (!id || !name || !cronSchedule) {
      throw new Error("Agent requires id, name, and cronSchedule");
    }
    this.id = id;
    this.name = name;
    this.cronSchedule = cronSchedule; // node-schedule cron string
  }

  /**
   * Subclasses implement this. It may do as much INTERNAL work as it wants
   * (search, analyze, draft, write to our own Firestore records) but any
   * GATED action must go through requestApproval() from ApprovalGate.js —
   * never executed directly here.
   */
  async run() {
    throw new Error(`Agent "${this.id}" must implement run()`);
  }
}
