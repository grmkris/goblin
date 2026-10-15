// The owner edits only reply-result meanings; saving creates a proposal that still needs exact-revision confirmation.
import { useId, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { SourceView } from '@goblin/contracts'
import {
  Alert,
  AlertDescription,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Textarea,
} from '@goblin/ui'
import { replyResultRules } from '../lib/source-setup.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { changeReplyResultMutation } from '../sources/queries.ts'

/** An advanced editor for the structured result comparisons visible in the Source review. */
export function SourceReplyRules({ source }: { readonly source: SourceView }) {
  const id = useId()
  const [text, setText] = useState(JSON.stringify(source.setup.reply?.result ?? null, null, 2))
  const saving = useMutation(changeReplyResultMutation)
  const result = replyResultRules(text)
  return (
    <Collapsible>
      <CollapsibleTrigger render={<Button variant="outline" size="sm" />}>Edit reply result rules</CollapsibleTrigger>
      <CollapsibleContent>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (result !== undefined) saving.mutate({ id: source.id, revision: source.revision, result })
          }}
        >
          <FieldGroup>
            <Field data-invalid={result === undefined}>
              <FieldLabel htmlFor={id}>Reply result rules</FieldLabel>
              <Textarea
                id={id}
                rows={8}
                value={text}
                spellCheck={false}
                aria-invalid={result === undefined}
                onChange={(event) => setText(event.target.value)}
              />
              <FieldDescription>
                {result === undefined
                  ? 'Use a JSON object with an accepted rule and optional retryable, rejected and retryAt rules, or null to clear.'
                  : 'Rules compare structured result pointers with values. For example: {"accepted":{"pointer":"/status","equals":"accepted"}}. Unmatched or uncertain results stop without retrying. Use null to clear.'}
              </FieldDescription>
            </Field>
            <p className="server-note">
              Saving pauses this Source and creates a new revision. Review it and Confirm to start it again.
            </p>
            {saving.error !== null && (
              <Alert variant="destructive">
                <AlertDescription>{messageOf(saving.error, 'change reply result rules')}</AlertDescription>
              </Alert>
            )}
            <div>
              <Button type="submit" size="sm" pending={saving.isPending} disabled={result === undefined}>
                Save for review
              </Button>
            </div>
          </FieldGroup>
        </form>
      </CollapsibleContent>
    </Collapsible>
  )
}
