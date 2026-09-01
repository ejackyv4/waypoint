# Demonstrating Waypoint

This is the practical checklist for a live Waypoint demonstration. For the
complete environment setup, see [`docs/BUILD.md`](docs/BUILD.md). For the short
sample conversation used to demonstrate transcription and summary generation,
see [`docs/DEMO-CONVERSATION.md`](docs/DEMO-CONVERSATION.md).

## Before the meeting

Use a physical iPhone when demonstrating visit recording. The iOS Simulator may
show the microphone permission prompt, but it does not provide usable microphone
input for this workflow.

From the repository root:

```bash
git switch main
git pull --ff-only
./spike/demo start
./spike/demo phone
./spike/demo status
```

Open Waypoint on the phone and confirm that it can sign in and reach the local
server. The Mac and iPhone must be on the same Wi-Fi network.

`./spike/demo reset` deletes and recreates the local demo database. Use it only
when a clean demo dataset is actually wanted.

## Demonstrating through Microsoft Teams

Do **not** run the Teams meeting, Teams screen sharing, Screen Recording or Local
Capture on the same iPhone that is recording the visit. Those features can own
the iPhone's active microphone session. iOS then refuses Waypoint's attempt to
activate its recorder.

The failure currently appears as:

```text
Couldn't start recording
FunctionCallException: Calling the 'prepareToRecordAsync' function has failed
...
Failed to configure audio session: Session activation failed
```

This is not a microphone-permission failure, an upload failure or lost visit
data. It happens before Waypoint starts recording or creates a file.

### Recommended Teams arrangement

1. Join the Teams meeting on the **Mac**, not the iPhone.
2. Use the **Mac's microphone** for the meeting.
3. Connect the iPhone to the Mac by cable.
4. Open **QuickTime Player > File > New Movie Recording**.
5. From the menu beside the record button, select the iPhone as the video source
   and the Mac's microphone as the audio source.
6. Share the QuickTime window in Teams. QuickTime does not need to record the
   demonstration; it is only mirroring the phone.
7. Before tapping **Record this visit**, confirm that the iPhone is not already
   showing a red recording activity or an orange microphone indicator.

Once Waypoint begins recording, the orange microphone indicator is expected—it
then means Waypoint is using the microphone.

If QuickTime or the meeting software still takes the phone's microphone, use a
second device to show the phone or use a prerecorded recording demonstration.

## If visit recording will not start

1. Look for a red recording activity or orange microphone indicator on the
   iPhone before Waypoint starts.
2. Stop Teams on the phone, Screen Recording, Local Capture, Voice Memos, phone
   calls and any other app using the microphone.
3. Return to Waypoint and try **Record this visit** again.
4. If the indicator is gone and recording still fails, capture the full alert,
   iOS version, device model and Metro output:

   ```bash
   tail -f /tmp/waypoint-metro.log
   ```

The app currently exposes the native Expo error for this conflict. A future UI
improvement should replace it with a clear explanation that another app or call
may be using the microphone.

## Suggested recording walkthrough

1. Start a scheduled visit on the physical iPhone.
2. Tap **Record this visit** and confirm the card changes to its active recording
   state.
3. Use the conversation in [`docs/DEMO-CONVERSATION.md`](docs/DEMO-CONVERSATION.md).
4. Stop the recording and wait for it to save.
5. Demonstrate playback, transcription and the generated summary/action items.
6. Explain that the original recording is the record; transcription and summary
   are machine-generated interpretations that can be regenerated or corrected.
