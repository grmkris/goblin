import { createFileRoute } from '@tanstack/react-router'
import { LegalPage } from '../components/legal.tsx'
export const Route = createFileRoute('/privacy')({ component: Privacy })
function Privacy() {
  return (
    <LegalPage title="Privacy policy">
      <p>
        We process your account email, name, sign-in credentials and sessions; conversations, uploaded context, tool
        results, usage and settings; and the permissions and credentials of services you connect. Sign-in codes are
        stored hashed and expire after 10 minutes.
      </p>
      <p>
        Cloudflare hosts goblin and sends sign-in mail. Model requests go to the deployment&apos;s model endpoint,
        including conversation context and relevant tool results. A connected tool receives the data needed for its
        authorized request.
      </p>
      <p>
        Outbound OAuth tokens are encrypted at rest. Essential session cookies support sign-in. Runtime logs contain
        route, request ID, status, error category and a short error message, and how each turn ran (timings, token
        counts, tool and model names, outcomes), without request bodies, conversation content or credentials.
      </p>
      <p>
        Your agent keeps a record of how each turn ran (the same timings, counts, names and outcomes, never content) for
        30 days. An app you connect to goblin over MCP gets only what you allow on the consent screen: asking your agent
        and, if you allow it, reading your conversations and how each turn ran without changing anything.
      </p>
      <p>
        Your agent data remains until you delete your account. Deletion erases its conversations, connections and app
        state; legally required records may remain. Outbound authorizations may need to be revoked at those services
        too.
      </p>
      <p>
        The final policy will identify the controller, contact for access or deletion requests, legal bases,
        subprocessors, international transfers and retention periods. Contact information is pending operator review.
      </p>
    </LegalPage>
  )
}
