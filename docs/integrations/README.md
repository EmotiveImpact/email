# Plugging an app in

Any booking app can use the platform in four parts. The guides below show each for Saleane and Caleane, with the exact places in their code.

1. **Keep the diary in step.** Send clients (`PUT /v1/contacts`) and bookings (`PUT /v1/appointments`, or 500 at a time with `POST /v1/appointments/batch`) whenever they change. Write each change to a small table inside the app's own transaction and send from a timer, so nothing is lost when the network is slow.
2. **Send email through the platform.** `POST /v1/emails` with the app's outbox id as the idempotency key, so retries never send twice.
3. **Show the studio.** A server route creates a one-time link (`POST /v1/studio/sessions`), and the page mounts it with `mountStudio` from `@platform/sdk/browser`. Allow the platform in the app's `frame-src`, and the app's address under Developers, Sites that can show the studio inside them.
4. **Forget clients when asked.** `POST /v1/contacts/erase` from wherever the app deletes a client.

Optional extras the flows use: a client's birthday as `attributes.birthday` (`MM-DD` or `YYYY-MM-DD`) for the birthday flow, and the business's review page as `brand.reviewUrl` for the review flow.

Who pays: an app made with an account pays for all its businesses on one bill. An app a customer adds in Developers is billed per business, so a stranger's app cannot send on the account's plan.

- [Saleane](saleane.md): beauty and wellness studios, with its own marketing to hand over.
- [Caleane](caleane.md): creative studios, with no marketing yet and no consent to start from.
