Project Specification Document: StoreAI / Store Listener (AI Sales Monitoring System)

1. Project Overview  
This system is an AI powered Retail Store Sales Monitoring and Conversation Intelligence Platform. There are two main components to this project:
1.	Windows Desktop Client Application (.exe Installer): Which will be installed on the computers or laptops of retail stores and will capture and transcribe audio conversations between the customer and the sales representative in real time.
2.	Centralized Web Portal (Admin Dashboard): Where the store admin will be able to monitor live streaming conversations, approve new stores, view single audio AI analysis, and generate full day Daily AI Reports (PDF format).
2. Technology Stack & APIs (Developer Freedom)
1.	Tech Stack Flexibility: Developers may choose any modern technology stack of their choice to build this system (such as Electron.js, Tauri, C#/.NET, or Python for the Desktop .exe; React.js, Next.js, Node.js, Python/FastAPI for the Web Portal; and WebSockets or Socket.io for real time communication).
2.	AI & Speech-to-Text APIs: For real time transcription, language detection, translation, and post conversation AI analysis, developers can use any best in class AI API such as Deepgram, Groq, Google Gemini, or OpenAI Whisper/GPT 
3.	Non-Negotiable Performance: Regardless of the technology used, there must be no compromise on the speed, low latency, and accuracy of real time transcription between the .exe app and the Web Portal. 
3. Component 1: Desktop Client Application (.exe File) Requirements 
3.1. Store Registration & Admin Approval Workflow
1.	Initial Registration: When a store user installs and opens the .exe file on their PC/Laptop, they must first register their store.
2.	Approval Gate: After registration, the .exe app will not start audio recording or streaming until the Admin approves that store's request from the Store Approvals module of the Web Portal.





3.2. Auto-Start & Auto Off Recording (Mandatory Core Feature)
1.	Auto Start on Approval: As soon as the Admin approves the store from the web portal, recording in the .exe app must start automatically.
2.	System Boot Auto Start: Whenever the store's computer or laptop is turned ON (boot/restart), the .exe application must start automatically in the background or foreground, and recording must begin immediately without any manual click.
3.	System Shutdown Auto Off: When the computer or laptop is turned OFF (shutdown/sleep), the recording must safely stop and sync to the server.
4.	Manual Override Controls: Along with Auto start and Auto off, there must also be a manual Start Recording and Stop Recording button on the .exe interface

3.3. Hardware / Microphone Detection
1.	Multi Mic Enumeration: The .exe application must automatically detect how many microphones are connected to the computer/system 
2.	Microphone Selection Dropdown: There must be a dropdown menu in the interface where the list of all connected microphones is displayed and the user or system can view/select the active input device.
3.	Active Audio Indicator: During recording, a live timer (such as 00:00 to 00:34) and a visual audio waveform indicator stating Microphone is active must be displayed.
3.4. Bilingual Speech Detection & Real Time English Transcription (Core Feature)
1.	Dual Language Detection (English + Spanish): The system must accurately detect two languages from the incoming microphone audio: English and Spanish.
2.	Always English Output: Whether the customer or sales representative speaks in English or Spanish, the transcription in the live conversation box of the .exe application and on the Web Portal must always appear in English in real time (Spanish audio must be translated/transcribed into English text in real time).

4. Component 2: Web Portal (Admin Dashboard) Requirements
4.1. Store Approvals Module
1.	There will be a Store Approvals tab in the sidebar where the Admin can review and approve Pending Requests for new store registrations. 

4.2. Live Monitor Module (Core Feature)
1.	Global Stream Listener: This module will monitor transmissions from all active stores in real time.
2.	Pending & Active Streams: When a stream arrives from a store, it will appear with the store's name and location, which can be accepted onto the monitor.
3.	Live vs. Ended Status Badge: If recording is in progress at a store, a green LIVE status badge must be shown on its card. As soon as recording stops on the .exe app or the computer turns off, that status on the Web Portal must immediately change to a red ENDED badge.
4.	Synchronized Real Time Transcription: The exact transcription running in real time in the .exe file interface must live stream word for word in English (not in Spanish) without any delay in the Live Monitor card of the Web Portal.
4.3. Overview Dashboard (Main Admin View)
1.	Top KPI Cards: There must be 4 main cards at the top of the dashboard: Total Conversations, Analyzed Conversations, Missed Opportunities, and Sales Opportunities.
2.	Conversation Activity Graph: There must be a line chart/graph of customer conversations analyzed over the last 7 days.
3.	AI Insights & Category Breakdown: One section must include high level AI Insights (such as how many times opportunities for a product were missed and how many conversations require manager review) and a Missed by Category breakdown (such as Charger, Other, Phone models).
4.	Download PDF Button: There must be a Download PDF button on the Overview page to download the summary report.
4.4. Recordings Library & Single-Audio AI Analysis Module
1.	Recordings Table: The Recordings Library will contain a list of all historical and current recordings, including Recording ID, Date & Time, Status (completed or live), Transcript Snippet, and an AI Analysis action button.
2.	Conversation Detail View (Single Audio Analysis): Clicking on any recording will open its detail screen containing the following elements:
3.	Header Info: Customer ID, Representative Name, Date, Time, and Analysis Status (Pending AI or Analyzed).
4.	Audio Player: A media player to play/pause and seek through the recorded audio of that specific conversation.
5.	Generate AI Report Button: Upon clicking, the AI will analyze that single conversation.
6.	Missed Opportunity Alert Box: If any opportunity is missed regarding sales Ai must be highlight in Box
7.	Structured AI Analysis Panel: This will display the conversation's SUMMARY, CUSTOMER NEEDS, CUSTOMER SENTIMENT (e.g., Positive), PRODUCTS DISCUSSED, and OPPORTUNITY TYPE.
8.	Speaker Separated Transcript: On the right side, the entire conversation will be displayed in chat bubble format, separating the dialogues of the Customer (C) and the Representative (R).
5. Core Requirement: Daily Reports Module & PDF Specification
The Web Portal must include a Daily Reports module where the Admin selects a date filter and clicks Run AI Analysis. This module will collectively analyze all audio recordings and transcripts from that entire day and generate a detailed Daily Report that can be exported as a PDF. 
The format of the Daily Report and its PDF must strictly follow the structure outlined below (No Compromise):
5.1. Report Header
1.	Title & Branding: At the top, there must be STORE LISTENER branding and the Report Date .
2.	Headline Banner: A one-line main summary of the day (e.g., Active day, $400 in sales, 4 conversations).
3.	Store & Timestamp: The name of the store and the exact date and time the report was generated.
5.2. Six Summary KPI Cards
The top section of the report must contain 6 metric boxes:
1.	REVENUE: Total sales for the entire day in dollars (e.g., $400) and how many items were sold (2 item(s) sold).
2.	MISSED: How many dollars of potential revenue were missed (e.g., $25 potential revenue).
3.	CONVERSATIONS: Total number of customers attended to.
4.	AVG TICKET: Average sale value per conversation.
5.	LOW STOCK: Count of low stock items.
6.	REDACTED: Count of redacted or removed sensitive details.
5.3. Daily Executive Summary & Key Points
1.	Narrative Summary: A paragraph stating how many customers visited the shop today, what the total revenue was, what percentage compliance remained, and how the overall customer interaction was.
2.	KEY POINTS (Bulleted List): Key takeaways extracted from the entire day's recordings, such as how many interactions had no speech detected, what discount the staff offered on which product to close a sale, and in which conversation customer service started with a negative refusal.
5.4. Customer Sentiment Visual Chart
1.	A circular/donut chart displaying the percentage breakdown of customer sentiment for the entire day. 
5.5. Actions For Tomorrow (AI Recommendations)
Numbered Action Plan (1, 2, 3...): Concrete AI instructions for the store staff and manager for the next day
5.6. Conversations & Transcripts Breakdown (Interaction-by-Interaction Log)
In the final section of the report, there must be an individual card for each recording of that day (1, 2, 3, 4...) containing these mandatory details:
1.	Interaction Metadata: Interaction number, exact time, store location, audio duration, sentiment tag, and a numeric performance score assigned by the AI.
2.	Transcript Summary: The transcript summary of that specific conversation enclosed in quotes.
3.	Coaching Tip: Below each interaction, there must be a Coaching line informing the staff what they did well or what they need to improve in that interaction.
 
6. Summary of Strict Core Deliverables vs. Enhancements
1.	Core Deliverable 1 (No Compromise): Mic detection in the .exe Desktop App, Store Registration + Admin Approval gate, Auto-Start/Auto-Off recording with Computer ON/OFF, English + Spanish speech detection, and ultra fast Real Time English Transcription on both the .exe and Web Portal (Live Monitor).
2.	Core Deliverable 2 (No Compromise): Single audio AI analysis and the Daily Reports Module where AI analysis of the entire day's recordings generates the exact STORE LISTENER PDF format (6 KPI cards, Key Points, Sentiment Chart, Actions for Tomorrow, and Scored Interaction Logs with Coaching).
3.	Enhancements Allowed: While keeping these two core deliverables intact, developers are free to make enhancements to the remaining secondary modules, UI/UX animations, and system settings as they see fit.



