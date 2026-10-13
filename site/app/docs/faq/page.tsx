import type { Metadata } from 'next';

import { DocPage, docsMetadata } from '@/components/doc-page';
import { AnchorHeading } from '@/components/heading';
import { InlineMarkdown } from '@/components/markdown';
import { slug } from '@/components/markdown-blocks';
import { FAQ } from '@/lib/faq';

export const metadata: Metadata = docsMetadata('/docs/faq');

export default function FaqPage() {
  return (
    <DocPage href="/docs/faq">
      <div className="grid gap-8">
        {FAQ.map(([question, answer]) => (
          <section key={question} aria-labelledby={slug(question)}>
            <AnchorHeading level={2} look={3} id={slug(question)} label={question}>
              {question}
            </AnchorHeading>
            <p className="mt-2 leading-relaxed text-muted">
              <InlineMarkdown text={answer} />
            </p>
          </section>
        ))}
      </div>
    </DocPage>
  );
}
