import { sampleSize } from 'lodash';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Coin, OfferStatus } from '@portfolio/enums';
import { CoinsApi } from '@portfolio/api';
import { InjectCoinsApi, InjectPortfolioOfferRepository } from '@portfolio/decorators';
import { CreatePortfolioOfferEntityParams, PortfolioOfferRepository } from '@portfolio/repositories';
import { PortfolioOfferEntity } from '@portfolio/entities';
import { calculatePercentageChange, getCurrentDayInUtc, getDateFromUtcDay } from '@common/utils';
import tokens from '@portfolio/data/tokens';

export interface PortfolioOfferService {
  getById(id: string): Promise<PortfolioOfferEntity | null>;
  getByDay(day: number): Promise<PortfolioOfferEntity | null>;
  listOffersForDays(days: number): Promise<PortfolioOfferEntity[]>;
  listOffersWaitingForCompletion(): Promise<PortfolioOfferEntity[]>;
  markOfferCompleted(offerId: string): Promise<void>;
}

@Injectable()
export class PortfolioOfferServiceImpl implements PortfolioOfferService {
  private MAX_DAYS_THRESHOLD = 3;
  private OFFERS_TO_GENERATE = 7;
  private MAX_TOKEN_OFFERS = 6;

  constructor(
    @InjectPortfolioOfferRepository() private readonly portfolioOfferRepository: PortfolioOfferRepository,
    @InjectCoinsApi() readonly coinsApi: CoinsApi,
  ) {}

  public listOffersForDays(days: number) {
    const currentDay = getCurrentDayInUtc();

    return this.portfolioOfferRepository.find({
      fromDay: currentDay - days,
      toDay: currentDay + 1,
    });
  }

  public listOffersWaitingForCompletion() {
    return this.portfolioOfferRepository.findByOfferStatus(OfferStatus.WaitingForCompletion);
  }

  public getByDay(day: number) {
    return this.portfolioOfferRepository.findByDay(day);
  }

  public async markOfferCompleted(offerId: string) {
    await this.portfolioOfferRepository.updateOneById(offerId, {
      offerStatus: OfferStatus.Completed,
    });
  }

  @Cron('0 * * * *')
  public async generateOffers() {
    const lastOffer = await this.portfolioOfferRepository.findLatest();

    const currentDay = getCurrentDayInUtc();

    const nextOfferDay = lastOffer ? lastOffer.getDay() + 1 : currentDay;

    if (nextOfferDay - currentDay > this.MAX_DAYS_THRESHOLD) {
      return;
    }

    const offers: CreatePortfolioOfferEntityParams[] = [];

    for (let day = nextOfferDay; day <= nextOfferDay + this.OFFERS_TO_GENERATE; day++) {
      const availableTokens: string[] = sampleSize(tokens, this.MAX_TOKEN_OFFERS * 2);

      offers.push({
        day,
        date: getDateFromUtcDay(day),
        tokenOffers: new Array(this.MAX_TOKEN_OFFERS).fill(null).map((_, index) => {
          return {
            firstToken: availableTokens[index * 2],
            secondToken: availableTokens[index * 2 + 1],
          };
        }),
      });
    }

    await this.portfolioOfferRepository.createMany(offers);
  }

  @Cron('0 * * * *')
  public async syncOffersPrices() {
    const offers = await this.portfolioOfferRepository.findByOfferStatus(
      OfferStatus.WaitingForPricing,
      getCurrentDayInUtc(),
    );

    if (!offers.length) {
      return;
    }

    for (const offer of offers) {
      try {
        const pricingChanges = {};

        let shouldSkipOffer = false;

        for (const tokenOffer of offer.getTokenOffers()) {
          await Promise.all(
            [tokenOffer.firstToken, tokenOffer.secondToken].map(async (token) => {
              const pricing = await this.coinsApi.getCoinPriceForDay(token as Coin, offer.getDay());

              if (!pricing) {
                shouldSkipOffer = true;
              }

              pricingChanges[token] = calculatePercentageChange(pricing.startDayPrice, pricing.endDayPrice);
            }),
          );

          if (shouldSkipOffer) {
            break;
          }
        }

        if (shouldSkipOffer) {
          continue;
        }

        await this.portfolioOfferRepository.updateOneById(offer.getId(), {
          offerStatus: OfferStatus.WaitingForCompletion,
          pricingChanges,
        });
      } catch (error) {
        Logger.error('Failed to update offer prices', error);
      }

      Logger.log(`Offer ${offer.getId()} prices updated`);
    }
  }

  public getById(id: string) {
    return this.portfolioOfferRepository.findById(id);
  }
}
