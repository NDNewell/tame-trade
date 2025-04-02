// Parse user message for trading or non-trading commands
async parseUserMessage(message: string): Promise<void> {
  // ... existing code ...

  // Match 'stop' command: stop <price> [quantity] [side]
  const stopRegex = /^stop (\d+(\.\d+)?)(?:\s+(\d+(\.\d+)?))?(?:\s+(buy|sell))?$/i;
  const stopMatch = message.match(stopRegex);

  if (stopMatch) {
    const price = parseFloat(stopMatch[1]);
    const explicitQuantity = stopMatch[3] ? parseFloat(stopMatch[3]) : undefined;
    const explicitSide = stopMatch[5]?.toLowerCase() as 'buy' | 'sell' | undefined;

    if (price <= 0) {
      return await this.outputManager.publishSystemMessage('Stop price must be greater than 0');
    }

    if (explicitQuantity !== undefined && explicitQuantity <= 0) {
      return await this.outputManager.publishSystemMessage('Quantity must be greater than 0');
    }

    try {
      if (explicitQuantity !== undefined) {
        // Use the new explicit quantity method for Hyperliquid
        if (this.exchangeClient.exchange?.id === 'hyperliquid') {
          await this.outputManager.publishSystemMessage(`Creating Hyperliquid stop order at ${price} with quantity ${explicitQuantity}${explicitSide ? ` (${explicitSide})` : ''}`);

          const order = await this.exchangeClient.createHyperliquidStop(
            this.symbol,
            price,
            explicitQuantity,
            explicitSide
          );

          if (order) {
            const sideDisplay = order.side.charAt(0).toUpperCase() + order.side.slice(1);
            await this.outputManager.publishSystemMessage(`✅ ${sideDisplay} stop order created at ${price} for ${explicitQuantity} ${this.symbol.split('/')[0]}`);
          } else {
            await this.outputManager.publishSystemMessage('❌ Failed to create stop order. Check logs for details.');
          }
        } else {
          // For other exchanges, use the standard method
          await this.outputManager.publishSystemMessage(`Creating stop order at ${price} with quantity ${explicitQuantity}${explicitSide ? ` (${explicitSide})` : ''}`);

          const order = await this.exchangeClient.createStop(
            this.symbol,
            price,
            explicitSide
          );

          if (order) {
            const sideDisplay = order.side.charAt(0).toUpperCase() + order.side.slice(1);
            await this.outputManager.publishSystemMessage(`✅ ${sideDisplay} stop order created at ${price}`);
          } else {
            await this.outputManager.publishSystemMessage('❌ Failed to create stop order. Check logs for details.');
          }
        }
      } else {
        // Use the standard method that auto-detects quantity
        await this.outputManager.publishSystemMessage(`Creating stop order at ${price}${explicitSide ? ` (${explicitSide})` : ''}`);

        const order = await this.exchangeClient.createStop(
          this.symbol,
          price,
          explicitSide
        );

        if (order) {
          const sideDisplay = order.side.charAt(0).toUpperCase() + order.side.slice(1);
          await this.outputManager.publishSystemMessage(`✅ ${sideDisplay} stop order created at ${price}`);
        } else {
          await this.outputManager.publishSystemMessage('❌ Failed to create stop order. Check logs for details.');
        }
      }
    } catch (error) {
      this.logger.error('Error creating stop order:', error);
      await this.outputManager.publishSystemMessage(`❌ Error creating stop order: ${(error as Error).message}`);
    }

    return;
  }

  // ... existing code ...
}
