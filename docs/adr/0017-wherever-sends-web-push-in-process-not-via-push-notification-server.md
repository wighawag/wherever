# wherever sends Web Push itself, in-process, instead of depending on `push-notification-server`

**Status:** accepted

The assistant's `assistant_notify` needs Web Push so wherever works as a chat app. A sibling project, `push-notification-server`, exists, but it is multi-tenant, keys recipients on `(address, domain)` with signer-based registration, and its own findings record an unauthenticated `/push` and non-idempotent fan-out. wherever is single-user with one shared token, so it generates its own VAPID keypair (state dir, ADR 0006), stores subscriptions behind its existing token gate, and sends the declarative `web_push: 8030` payload its service worker already renders. That is a small module with no extra deployment and no foreign identity model. The sibling's WebCrypto sender may be borrowed as code. The unused template subscribe client built for that service's `/register` + signer model is deleted rather than adapted.
