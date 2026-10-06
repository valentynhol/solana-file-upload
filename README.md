# Solana Native Layer-1 File Uploader

A full-stack, decentralized file storage prototype built entirely on the Solana blockchain. This project leverages the Solana ledger to chunk, upload, and reconstruct files dynamically directly on Layer-1 without external storage protocols like IPFS or Arweave.

## How It Works

The system operates across two core layers:

### 1. Smart Contract (Anchor Program)
At the heart of the system is an Anchor-based Rust smart contract. When a user uploads a file, the program performs the following:
* **Initializes a File Manifest:** It creates a PDA (Program Derived Address) representing the `FileManifest`. This account acts as a directory, storing metadata like the randomly generated `file_id`, the original `filename`, and the `mime_type` (e.g., `image/png` or `application/pdf`).
* **Stores Signatures:** It contains an instruction to dynamically append the cryptographic transaction signatures of every chunk uploaded. 

*(A **PDA** is a unique Solana account that a specific program can algorithmically derive and "own." Think of it as a dedicated row in a database table controlled by our smart contract.)*

### 2. Frontend Chunking & Assembly (Vite + React)
Instead of storing the heavy binary file data directly in the Solana account state (which is extremely expensive and size-restricted), we exploit the ledger's transaction history!
* **Uploading:** The frontend slices the user's file into `800-byte` chunks. For each chunk, it wraps the raw binary data directly into the instruction payload of a native Solana transaction (using a custom discriminator). The transaction is fired over **RPC** (Remote Procedure Call - the API layer used to communicate with the blockchain node). The transaction is confirmed, permanently etching the binary chunk into the blockchain's historical ledger, and its signature is saved to the PDA manifest.
* **Downloading:** When a user requests a file, the frontend queries the `FileManifest` PDA. It iterates through the saved transaction signatures, queries the RPC node for the historical transaction data, extracts the binary instruction payload out of each one, and seamlessly reassembles the `Blob` in the browser for the user to download!

*(Note: We use standard `MessageV0` transactions constrained to 800 bytes per chunk to comfortably fit within Solana's current 1,232-byte network packet limits.)*

## Project Structure

- `programs/solana_chunk_uploader/` - The Rust/Anchor smart contract.
- `frontend/` - The React/Vite web application.
- `test-ledger/` - The local instance of the Solana blockchain database (generated when running `solana-test-validator`).

## Running Locally

### Prerequisites
- Node.js (v18+)
- Rust & Cargo
- Solana CLI (`v1.18+` or Agave `v2.0+`)
- Anchor CLI

### Step 1: Start the Local Blockchain
In the root directory, start the local Solana test validator. This spins up your own private Solana network.
```bash
solana-test-validator
```

### Step 2: Build and Deploy the Contract
In a new terminal window, ensure your Solana config is pointed at localhost:
```bash
solana config set --url localhost
```

Then, deploy the Anchor program:
```bash
cd solana_chunk_uploader
anchor build
anchor deploy
```

### Step 3: Run the Frontend
```bash
cd solana_chunk_uploader/frontend
npm install
npm run dev
```

Open `http://localhost:3000` in your browser. The app will automatically generate throwaway keypairs, request localnet airdrops, and handle everything for you!
