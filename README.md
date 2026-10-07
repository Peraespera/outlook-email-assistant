# Outlook Email Assistant

Desktop app that connects to Outlook, summarizes the day's emails, surfaces key contacts and reminders, and suggests replies with an OpenAI-powered module.

Built as an internal prototype at a consulting firm to reduce the time spent triaging email.

## Features
- Daily email summary
- Top contacts and key reminders
- AI-generated reply suggestions

## Stack
- Frontend: React, TypeScript, Vite
- Backend: Node.js, Express
- Desktop packaging: Tauri
- Integrations: Microsoft Graph API, OpenAI API

## Setup
1. Install dependencies in the project root and in `server/`: `npm install`
2. Copy `.env.example` to `.env` and `server/.env.example` to `server/.env`, then fill in your values
3. Register an app in Azure with Microsoft Graph delegated permissions to read mail
4. Start the backend: `cd server && npm run dev`
5. Start the frontend: `npm run dev` (browser) or `npm run tauri dev` (desktop app)

## Notes
Prototype built by me; not deployed in production. No real email data is included in this repository.
