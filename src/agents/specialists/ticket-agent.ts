import { SpecialistAgent } from "./base";
import { draftTicket, ticketInputSchema, ticketOutputSchema, type TicketAgentInput, type TicketDraftOutput } from "./ticket-draft";

export { draftTicket, type TicketAgentInput, type TicketDraftOutput } from "./ticket-draft";

/**
 * Writes the ticket an IT engineer would want to read: a specific title, a short summary in plain
 * words, the right team (category) and priority. Steps tried and device come from state, not the
 * model, so they're always accurate.
 */
export class TicketAgent extends SpecialistAgent<TicketAgentInput, TicketDraftOutput> {
  readonly displayName = "Ticket agent";
  readonly inputSchema = ticketInputSchema;
  readonly outputSchema = ticketOutputSchema;

  protected run(i: TicketAgentInput): Promise<TicketDraftOutput> {
    return draftTicket(this.env, i);
  }

  protected summarize(o: TicketDraftOutput) {
    return `${o.priority} ${o.category}: ${o.title}`;
  }
}
