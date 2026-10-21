# Store Listen API HTTP collection

Use these files in VS Code with the REST Client extension.

1. Open one of the `.http` files.
2. Click `Send Request` on the login block first.
3. The token is stored in `{{token}}` for later requests.
4. Start the Node.js backend with:
   `npm --prefix backend run dev`
5. Update `baseUrl` if needed.

## Base URL
- Local: http://127.0.0.1:8000

## Auth flow
- Login returns a JWT token.
- Use `Authorization: Bearer {{token}}` for protected routes.
