use anchor_lang::prelude::*;

declare_id!("89VFKhJhTdFX3hTZWtBwrXtTCSyALN5KrjBfqtC856CH");

#[program]
pub mod solana_chunk_uploader {
    use super::*;

    pub fn initialize_file(
        ctx: Context<InitializeFile>,
        file_id: String,
        filename: String,
        mime_type: String,
    ) -> Result<()> {
        let manifest = &mut ctx.accounts.manifest;
        manifest.file_id = file_id;
        manifest.filename = filename;
        manifest.mime_type = mime_type;
        manifest.chunk_signatures = Vec::new();
        Ok(())
    }

    pub fn append_chunk_signatures(
        ctx: Context<AppendChunkSignatures>,
        _file_id: String,
        signatures: Vec<[u8; 64]>,
    ) -> Result<()> {
        let manifest = &mut ctx.accounts.manifest;
        for sig in signatures {
            manifest.chunk_signatures.push(sig);
        }
        Ok(())
    }

    pub fn upload_chunk(
        _ctx: Context<UploadChunk>,
        _chunk: Vec<u8>,
    ) -> Result<()> {
        // Dummy instruction to store raw chunk bytes in the transaction payload.
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(file_id: String, filename: String, mime_type: String)]
pub struct InitializeFile<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        init,
        payer = user,
        space = 8 + 4 + file_id.len() + 4 + filename.len() + 4 + mime_type.len() + 4, // empty vec
        seeds = [b"manifest", file_id.as_bytes()],
        bump
    )]
    pub manifest: Account<'info, FileManifest>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(file_id: String, signatures: Vec<[u8; 64]>)]
pub struct AppendChunkSignatures<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"manifest", file_id.as_bytes()],
        bump,
        realloc = manifest.to_account_info().data_len() + signatures.len() * 64,
        realloc::payer = user,
        realloc::zero = false,
    )]
    pub manifest: Account<'info, FileManifest>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UploadChunk {}

#[account]
pub struct FileManifest {
    pub file_id: String,
    pub filename: String,
    pub mime_type: String,
    pub chunk_signatures: Vec<[u8; 64]>,
}
