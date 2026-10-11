# Plugging an app in

Any booking app can use the platform in four parts. The guides below show each for Saleane and Caleane, with the exact places in their code.

1. **Keep the diary in step.** Send clients (`PUT /v1/contacts`) and bookings (`PUT /v1/appointments`, or 500 at a time with `POST /v1/appointments/batch`) whenever they change. Write each change to a small table inside the app's own transaction and send from a timer, so nothing is lost when the network is slow.
2. **Send email through the platform.** `POST /v1/emails` with the app's outbox id as the idempotency key, so retries never send twice.
3. **Show the studio.** A server route creates a one-time link (`POST /v1/studio/sessions`), and the page mounts it with `mountStudio` from `@platform/sdk/browser`. Allow the platform in the app's `frame-src`, and the app's address under Developers, Sites that can show the studio inside them.
4. **Forget clients when asked.** `POST /v1/contacts/erase` from wherever the app deletes a client.

- [Saleane](saleane.md): beauty and wellness studios, with its own marketing to hand over.
- [Caleane](caleane.md): creative studios, with no marketing yet and no consent to start from.
