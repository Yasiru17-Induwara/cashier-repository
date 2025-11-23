/ ======================================================================
// 3. CASHIER API ENDPOINTS (YOUR PART)
// ======================================================================

// --- GET /api/outstanding-bills (Cashier) ---
app.get('/api/outstanding-bills', async (req, res) => {
    try {
        const pool = await connectDb();
        const query = `
            SELECT 
                B.BillID, B.CustomerID, C.CustomerName, B.BillDate, B.DueDate, B.AmountDue
            FROM [dbo].[Bill] AS B
            JOIN [dbo].[Customer] AS C ON B.CustomerID = C.CustomerID
            WHERE 
                B.Status IN ('Unpaid', 'Overdue')
        `;
        const result = await pool.request().query(query);
        res.json({ success: true, data: result.recordset });
    } catch (err) {
        console.error('Get Outstanding Bills Error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to retrieve outstanding bills.' });
    }
});

// --- GET /api/unbilled-readings (Cashier) ---
app.get('/api/unbilled-readings', async (req, res) => {
    try {
        const pool = await connectDb();
        const query = `
            SELECT 
                R.ReadingID, 
                R.MeterID, 
                M.CustomerID
            FROM [dbo].[Meter_Reading] AS R
            JOIN [dbo].[Meter] AS M ON R.MeterID = M.MeterID
            WHERE 
                R.ReadingID NOT IN (SELECT ReadingID FROM [dbo].[Bill])
        `;
        const result = await pool.request().query(query);
        res.json({ success: true, data: result.recordset });
    } catch (err) {
        console.error('Get Unbilled Readings Error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to retrieve unbilled readings.' });
    }
});

// --- GET /api/reading-details/:id (Cashier) ---
// This endpoint calls your SQL Function
app.get('/api/reading-details/:id', async (req, res) => {
    try {
        const readingId = req.params.id;
        const pool = await connectDb();

        // This advanced query finds the previous reading and calls your SQL function
        const query = `
            DECLARE @ReadingID INT = @id;

            -- This temporary table finds the current reading and its previous reading
            ;WITH ReadingWithPrevious AS (
                SELECT
                    ReadingID,
                    MeterID,
                    ReadingValue AS CurrentReadingValue,
                    ReadingDate,
                    -- Find the previous reading value for this meter using LAG
                    LAG(ReadingValue, 1, 0) OVER (PARTITION BY MeterID ORDER BY ReadingDate, ReadingID) AS PreviousReadingValue,
                    (SELECT M.UtilityID FROM [dbo].[Meter] M WHERE M.MeterID = R.MeterID) AS UtilityID
                FROM 
                    [dbo].[Meter_Reading] R
            )
            -- Select all the data you need from that temporary table
            SELECT
                RWP.MeterID,
                RWP.CurrentReadingValue,
                RWP.PreviousReadingValue,
                (RWP.CurrentReadingValue - RWP.PreviousReadingValue) AS Consumption,
                
                -- Call your SQL function to get the real amount
                CASE 
                    WHEN RWP.UtilityID = 'UTIL-01' THEN 
                        -- Use the Electricity function
                        dbo.fn_CalculateElectricityBill(RWP.CurrentReadingValue - RWP.PreviousReadingValue)
                    ELSE 
                        -- Use a simple (Rate * Consumption) for other utilities (like Water)
                        (RWP.CurrentReadingValue - RWP.PreviousReadingValue) * (SELECT TOP 1 T.Rate FROM [dbo].[Tariff] T WHERE T.UtilityID = RWP.UtilityID ORDER BY T.MinUnits)
                END AS CalculatedAmountDue,
                
                (SELECT M.CustomerID FROM [dbo].[Meter] M WHERE M.MeterID = RWP.MeterID) AS CustomerID
            FROM 
                ReadingWithPrevious RWP
            WHERE 
                RWP.ReadingID = @ReadingID;
        `;
        
        const request = pool.request();
        request.input('id', sql.Int, readingId);
        const result = await request.query(query);

        if (result.recordset.length > 0) {
            res.json({ success: true, data: result.recordset[0] });
        } else {
            res.status(404).json({ success: false, message: 'Reading details not found.' });
        }

    } catch (err) {
        console.error('Get Reading Details Error:', err.message);
        res.status(500).json({ success: false, message: 'Server error fetching reading details.' });
    }
});


// --- POST /api/generate-bill-from-reading (Cashier) ---
app.post('/api/generate-bill-from-reading', async (req, res) => {
    const {
        'reading-id': readingId,
        'customer-name': customerId, // This field holds the CustomerID
        'meter-id': meterId,
        'bill-date': billDate,
        'due-date': dueDate,
        'previous-reading': previousReading,
        'current-reading': currentReading,
        'amount-due': amountDue
    } = req.body;

    const billId = 'BILL-' + Date.now(); // Unique Bill ID

    try {
        const pool = await connectDb();
        const request = pool.request();

        const query = `
            INSERT INTO [dbo].[Bill] 
                (BillID, CustomerID, MeterID, ReadingID, BillDate, DueDate, 
                 PreviousReadingValue, CurrentReadingValue, AmountDue, Status)
            VALUES 
                (@billId, @customerId, @meterId, @readingId, @billDate, @dueDate,
                 @previousReading, @currentReading, @amountDue, 'Unpaid')
        `;

        request.input('billId', sql.NVarChar, billId);
        request.input('customerId', sql.NVarChar, customerId);
        request.input('meterId', sql.NVarChar, meterId);
        request.input('readingId', sql.Int, readingId);
        request.input('billDate', sql.Date, billDate);
        request.input('dueDate', sql.Date, dueDate);
        request.input('previousReading', sql.Decimal(10, 2), previousReading);
        request.input('currentReading', sql.Decimal(10, 2), currentReading);
        request.input('amountDue', sql.Decimal(10, 2), amountDue);
        
        await request.query(query);
        res.json({ success: true, message: 'Bill generated successfully!' });
    } catch (err) {
        console.error('Generate Bill Error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to generate bill. Is this reading already billed?' });
    }
});


// --- POST /recordPayment (Cashier) ---
// This uses your Stored Procedure
app.post('/recordPayment', async (req, res) => {
    const { 
        'bill-id': billId, 
        'payment-amount': paymentAmount, 
        'payment-method': paymentMethod 
    } = req.body;

    const cashierId = 'U-003'; // Hard-coded Cashier ID

    try {
        const pool = await connectDb();
        const request = pool.request();

        await request
            .input('BillID', sql.NVarChar, billId)
            .input('UserID', sql.NVarChar, cashierId)
            .input('PaymentAmount', sql.Decimal(10, 2), paymentAmount)
            .input('PaymentMethod', sql.NVarChar, paymentMethod)
            .execute('[dbo].[sp_RecordPayment]'); 

        res.json({ success: true, message: 'Payment successfully recorded and bill updated.' });
    } catch (err) {
        console.error('Record Payment Error:', err.message);
        res.status(500).json({ success: false, message: 'Payment failed: Bill not found or database error.' });
    }
});

// ======================================================================
// END OF CASHIER API ENDPOINTS
// ======================================================================
