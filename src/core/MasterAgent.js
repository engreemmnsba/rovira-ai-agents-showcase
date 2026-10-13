import schedule from "node-schedule";
import { db } from "../config/firebase.js";
import { logAudit } from "./AuditLog.js";
import { isRegisteredAgent } from "./Permissions.js";

class MasterAgent {
  constructor() {
    this.agents = new Map();
  }

  /**
   * Registers a worker agent. Refuses agents with no permission matrix in
   * Permissions.js — an agent that isn't explicitly declared there cannot
   * run, period.
   */
  register(agent) {
    if (!isRegisteredAgent(agent.id)) {
      throw new Error(
        `Refusing to register agent "${agent.id}": no entry in AGENT_PERMISSIONS (src/core/Permissions.js). ` +
        `Add its permission matrix first.`
      );
    }
    this.agents.set(agent.id, agent);
    console.log(`🧩 Registered agent: ${agent.name} (id: ${agent.id}, schedule: ${agent.cronSchedule})`);
  }

  /**
   * Runs every registered agent once immediately, then on its own cron
   * schedule from then on.
   */
  start() {
    console.log(`\n🧠 Master Agent starting — ${this.agents.size} agent(s) registered\n`);
    for (const agent of this.agents.values()) {
      this._runAgentSafely(agent);
      schedule.scheduleJob(agent.cronSchedule, () => this._runAgentSafely(agent));
    }
  }

  /**
   * Ad-hoc trigger for one already-registered agent, on demand (e.g. from
   * a Telegram command) — same safe path as a scheduled run: same task
   * record, same audit trail, same try/catch. Not a new capability, just a
   * manual way to fire an existing one.
   */
  async runNow(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`No such agent: "${agentId}". Registered agents: ${[...this.agents.keys()].join(", ")}`);
    }
    const outcome = await this._runAgentSafely(agent);
    // Manual runs report failure to the caller (the Telegram bot) instead
    // of looking like success; scheduled runs still just log it.
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.result;
  }

  async _runAgentSafely(agent) {
    const taskRef = await db.collection("tasks").add({
      agentId: agent.id,
      status: "running",
      createdAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
      error: null
    });

    await logAudit({
      actorType: "system",
      agentId: agent.id,
      action: "RUN_START",
      status: "EXECUTED",
      details: `Task ${taskRef.id} started`,
      relatedTaskId: taskRef.id
    });

    try {
      const result = await agent.run();
      await taskRef.update({ status: "completed", completedAt: new Date() });
      await logAudit({
        actorType: "system",
        agentId: agent.id,
        action: "RUN_END",
        status: "EXECUTED",
        details: `Task ${taskRef.id} completed`,
        relatedTaskId: taskRef.id
      });
      return { ok: true, result };
    } catch (error) {
      await taskRef.update({ status: "failed", error: error.message, completedAt: new Date() });
      await logAudit({
        actorType: "system",
        agentId: agent.id,
        action: "RUN_ERROR",
        status: "FAILED",
        details: error.message,
        relatedTaskId: taskRef.id
      });
      console.error(`❌ Agent "${agent.id}" failed:`, error.message);
      return { ok: false, error: error.message };
    }
  }
}

// Singleton — one orchestrator per process.
export default new MasterAgent();
