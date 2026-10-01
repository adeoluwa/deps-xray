const pad = require("tiny-pad");

// The app's whole job: print an invoice number padded to 8 characters.
console.log(`Invoice #${pad("42", 8)}`);
