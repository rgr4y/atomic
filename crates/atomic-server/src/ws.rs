//! WebSocket endpoint for real-time event streaming

use crate::state::AppState;
use actix_web::{web, HttpRequest, HttpResponse};
use actix_ws::AggregatedMessage;
use futures::StreamExt;
use tokio::sync::broadcast;

/// WebSocket upgrade handler
/// Auth via query param: /ws?token=xxx
pub async fn ws_handler(
    req: HttpRequest,
    stream: web::Payload,
    state: web::Data<AppState>,
    query: web::Query<WsQuery>,
) -> Result<HttpResponse, actix_web::Error> {
    // Authenticate via query param
    let core = state.manager.active_core()
        .map_err(|_| actix_web::error::ErrorInternalServerError("Failed to get database"))?;
    match core.verify_api_token(&query.token) {
        Ok(Some(_)) => {}
        _ => return Ok(HttpResponse::Unauthorized().finish()),
    }

    let (response, mut session, msg_stream) = actix_ws::handle(&req, stream)?;

    // Subscribe to broadcast channel
    let mut rx = state.event_tx.subscribe();

    // Clone session for the reader task
    let mut session_for_reader = session.clone();

    // Spawn task to read incoming messages (handle pings from client)
    let mut msg_stream = msg_stream
        .aggregate_continuations()
        .max_continuation_size(2_usize.pow(20));

    actix_web::rt::spawn(async move {
        while let Some(Ok(msg)) = msg_stream.next().await {
            match msg {
                AggregatedMessage::Ping(data) => {
                    if session_for_reader.pong(&data).await.is_err() {
                        break;
                    }
                }
                AggregatedMessage::Text(text) => {
                    // Client sends JSON pings like {"type":"ping"} — echo back a pong
                    if text.contains("ping") {
                        if session_for_reader
                            .text(r#"{"type":"pong"}"#)
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                }
                AggregatedMessage::Close(_) => break,
                _ => {}
            }
        }
    });

    // Spawn task to forward broadcast events to this WebSocket client
    actix_web::rt::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    if let Ok(json) = serde_json::to_string(&event) {
                        if session.text(json).await.is_err() {
                            break; // Client disconnected
                        }
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    eprintln!("WebSocket client lagged, skipped {} events", n);
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    Ok(response)
}

#[derive(serde::Deserialize)]
pub struct WsQuery {
    pub token: String,
}
